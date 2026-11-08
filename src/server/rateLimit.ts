// API の呼び出し回数の上限。公開URLに連続で送られたときに、Gemini や読み上げの費用がかさんだり、
// 利用枠（429）を使い切ってほかの人まで止まったりしないようにする。
// 数えるのはこのサーバー（Cloud Run ではインスタンス）ごとなので、上限はおおよそになる。
// インスタンスの数はデプロイ時に最大インスタンス数で抑える

import type { IncomingMessage } from 'node:http';

export type RateLimitGroup = 'gemini' | 'tts' | 'record';

export interface RateLimitRule {
  /** 1つの接続元が、時間の枠の中で呼べる回数 */
  perClient: number;
  /** サーバー全体で、時間の枠の中で呼べる回数 */
  global: number;
}

/** ふつうに遊ぶと Gemini を呼ぶAPIは1分に6〜8回ほど。読み上げは発言ごとに呼ぶので多め */
export const DEFAULT_RATE_LIMITS: Record<RateLimitGroup, RateLimitRule> = {
  gemini: {
    perClient: readLimit('RATE_LIMIT_GEMINI_PER_CLIENT', 20),
    global: readLimit('RATE_LIMIT_GEMINI_GLOBAL', 120),
  },
  tts: {
    perClient: readLimit('RATE_LIMIT_TTS_PER_CLIENT', 60),
    global: readLimit('RATE_LIMIT_TTS_GLOBAL', 300),
  },
  /** 挑戦の始まりと終わりの記録。1回の挑戦で2回ほど */
  record: {
    perClient: readLimit('RATE_LIMIT_RECORD_PER_CLIENT', 20),
    global: readLimit('RATE_LIMIT_RECORD_GLOBAL', 300),
  },
};

const WINDOW_MS = 60_000;

/** Gemini を呼ぶAPIと、読み上げのAPI。ここにないAPIは数えない */
const GROUP_BY_PATH: Record<string, RateLimitGroup> = {
  '/api/chat': 'gemini',
  '/api/apply': 'gemini',
  '/api/evaluate': 'gemini',
  '/api/owner-line': 'gemini',
  '/api/transcribe': 'gemini',
  '/api/decision': 'gemini',
  '/api/tts': 'tts',
  '/api/run-event': 'record',
};

function readLimit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function rateLimitGroupOf(method: string | undefined, path: string): RateLimitGroup | null {
  if (method !== 'POST') return null;
  return GROUP_BY_PATH[path] ?? null;
}

/**
 * 接続元を見分けるキー。Cloud Run では X-Forwarded-For の最後に、Google の受付が見た接続元が付く。
 * 先頭は送る側が自由に書けるので使わない
 */
export function clientKeyOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? req.socket.remoteAddress ?? 'unknown';
}

/** 直近の時間の枠に呼んだ時刻を覚えておき、上限を超えたら断る（スライディングウィンドウ） */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly rules: Record<RateLimitGroup, RateLimitRule>;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    rules: Record<RateLimitGroup, RateLimitRule> = DEFAULT_RATE_LIMITS,
    windowMs = WINDOW_MS,
    now: () => number = () => Date.now(),
  ) {
    this.rules = rules;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** 呼んでよければ回数に数えて ok を返す。断るときは、あと何秒待てばよいかを返す */
  take(group: RateLimitGroup, clientKey: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const rule = this.rules[group];
    const t = this.now();
    const clientHits = this.recent(`${group}:client:${clientKey}`, t);
    const globalHits = this.recent(`${group}:global`, t);
    const full =
      clientHits.length >= rule.perClient
        ? clientHits
        : globalHits.length >= rule.global
          ? globalHits
          : null;
    if (full) {
      const retryAfterSec = Math.max(1, Math.ceil((full[0] + this.windowMs - t) / 1000));
      return { ok: false, retryAfterSec };
    }
    clientHits.push(t);
    globalHits.push(t);
    return { ok: true };
  }

  private recent(key: string, t: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    this.hits.set(key, list);
    return list;
  }

  /** 古い記録を捨てる。接続元が増え続けても記録がたまらないように、定期的に呼ぶ */
  prune(): void {
    const t = this.now();
    for (const [key, list] of this.hits) {
      const kept = list.filter((at) => t - at < this.windowMs);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}
