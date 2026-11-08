import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApplyRequest,
  AppSpec,
  ChatHistoryEntry,
  ChatRequest,
  DecisionStage,
  EvaluateRequest,
  OwnerLineRequest,
  LatestReviewRecord,
  RecordDecisionRequest,
  TargetCohortId,
  TranscribeRequest,
  TtsRequest,
} from '../shared/types.ts';
import { ACTIVE_THEME } from '../shared/initialTheme.ts';
import {
  AiNotConfiguredError,
  AiTimeoutError,
  applyOptionToSpec,
  chatWithStudio,
  evaluateAppWithPersonas,
  getAiConnectionStatus,
  recordHumanDecisionWithFunctionCalling,
  transcribeAndRefineUserAudio,
  voiceOwnerLine,
} from './gemini.ts';
import {
  getPublicAggregateStats,
  synthesizeStudioSpeech,
  recordRunEvent,
  type RunEventInput,
} from './store.ts';
import {
  ConcurrencyGate,
  DailyLimitError,
  MAX_CONCURRENT_PER_CLIENT,
  RateLimiter,
  clientKeyOf,
  dailyGeminiCounter,
  isAllowedOrigin,
  isBotUserAgent,
  maxBodyBytesFor,
  rateLimitGroupOf,
} from './rateLimit.ts';
import { describeErrorForLog } from './logSafe.ts';
import { PromptRejectedError, assertPromptAllowed } from './modelArmor.ts';

const apiRateLimiter = new RateLimiter();
const geminiConcurrency = new ConcurrencyGate(MAX_CONCURRENT_PER_CLIENT);
// 使われなくなった接続元の記録を捨てる。サーバーの終了を妨げないよう unref する
setInterval(() => apiRateLimiter.prune(), 5 * 60_000).unref();

const MAX_TEXT_INPUT_LENGTH = 2_000;
const VALID_DECISION_STAGES = new Set<DecisionStage>([
  'select_cohort',
  'apply_change',
  'review_disposition',
]);
const VALID_OWNER_SITUATIONS = new Set<OwnerLineRequest['situation']>([
  'change',
  'closing',
  'reply',
]);

/** 発言の番号は 0 以上の整数だけを受け付ける。それ以外は番号なしとして扱う */
function sanitizeTurnIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000
    ? value
    : undefined;
}

const RUN_ID_RE = /^run-[0-9a-z-]{1,40}$/;
const COHORT_IDS = new Set<string>(ACTIVE_THEME.cohorts.map((c) => c.id));
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_TEXT_LENGTH = 1_000;

/** 挑戦の番号は画面が作る形だけを受け付ける。記録に自由な文字列が入らないようにする */
function sanitizeRunId(value: unknown): string | undefined {
  return typeof value === 'string' && RUN_ID_RE.test(value) ? value : undefined;
}

/** 客層は題材に決まっているものだけを受け付ける */
function sanitizeCohortId(value: unknown): TargetCohortId | undefined {
  return typeof value === 'string' && COHORT_IDS.has(value) ? (value as TargetCohortId) : undefined;
}

function sanitizeComponentIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.length <= 80).slice(0, 20)
    : [];
}

/** 会話の履歴は件数と長さを抑え、形の正しいものだけを Gemini に渡す */
function sanitizeHistory(value: unknown): ChatHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (e): e is ChatHistoryEntry =>
        Boolean(e) && typeof e.speaker === 'string' && typeof e.text === 'string',
    )
    .slice(-MAX_HISTORY_ENTRIES)
    .map((e) => ({ speaker: e.speaker.slice(0, 20), text: e.text.slice(0, MAX_HISTORY_TEXT_LENGTH) }));
}

/** 直近のお客さんの反応の記録も、人数と行数と長さを抑える */
function sanitizeLatestReviews(value: unknown): LatestReviewRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<LatestReviewRecord>;
  if (!Array.isArray(v.reviews)) return undefined;
  const text = (s: unknown, max: number) => (typeof s === 'string' ? s.slice(0, max) : '');
  return {
    screenLabel: text(v.screenLabel, 40),
    isCurrentScreen: v.isCurrentScreen === true,
    reviews: v.reviews.slice(0, 9).map((r) => ({
      name: text(r?.name, 40),
      outcome: r?.outcome,
      actionTrace: Array.isArray(r?.actionTrace) ? r.actionTrace.slice(0, 40).map((t) => text(t, 200)) : [],
    })),
    ownerMetrics: Array.isArray(v.ownerMetrics)
      ? v.ownerMetrics.slice(0, 10).map((m) => ({
          label: text(m?.label, 40),
          count: typeof m?.count === 'number' ? m.count : 0,
          missing: m?.missing === true,
        }))
      : undefined,
  };
}

/** 学習者が自分で書いた発言を集める。今の発言に加え、会話の履歴にある学習者の発言も調べる */
function learnerTextsForScreening(message: string, history: ChatHistoryEntry[]): string {
  return [...history.filter((e) => e.speaker === 'ユーザー').map((e) => e.text), message].join('\n');
}

function isValidAppSpec(value: unknown): value is AppSpec {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppSpec>;
  return Array.isArray(candidate.components) && Array.isArray(candidate.state);
}

class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor() {
    super('リクエストサイズが上限を超えています');
    this.name = 'PayloadTooLargeError';
  }
}

/** 本文を読む。大きさの上限はAPIごとに決め、画像や音声を送らないAPIは小さく抑える */
function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const maxBytes = maxBodyBytesFor((req.url ?? '').split('?')[0]);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // 読むのをやめ、413 を返してから接続を閉じる。先に接続を切ると、画面に理由が届かない
        req.removeAllListeners('data');
        req.pause();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(body);
}

/**
 * `/api/*` リクエストを処理する共通ハンドラ。
 * 処理した場合は true、対象外パスの場合は false を返す。
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = (req.url ?? '').split('?')[0];
  if (!url.startsWith('/api/')) {
    return false;
  }

  // 自動スクリプトやクローラによる直接の API 呼び出しは断る
  if (isBotUserAgent(req)) {
    sendJson(res, 403, { error: '自動プログラムからの呼び出しはできません。' });
    return true;
  }

  // ほかのサイトのページや、Origin のないスクリプトからの POST は断る
  if (req.method === 'POST' && !isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'このサイトの画面からだけ使えます。' });
    return true;
  }

  // Gemini や読み上げを呼ぶAPIは、本文を読む前に回数の上限を確かめる
  const limitGroup = rateLimitGroupOf(req.method, url);
  const clientKey = clientKeyOf(req);
  if (limitGroup) {
    if (limitGroup === 'gemini' && dailyGeminiCounter.isExhausted()) {
      const err = new DailyLimitError();
      sendJson(res, err.statusCode, { error: err.message, code: err.code });
      return true;
    }
    const taken = apiRateLimiter.take(limitGroup, clientKey);
    if (!taken.ok) {
      sendJson(
        res,
        429,
        { error: `混み合っています。${taken.retryAfterSec}秒ほど待ってから、もう一度送ってください。` },
        { 'Retry-After': String(taken.retryAfterSec) },
      );
      return true;
    }
  }

  // 1つの接続元から同時に処理する数を抑え、一度に大量に送られても利用枠を使い切らないようにする
  if (limitGroup === 'gemini') {
    if (!geminiConcurrency.tryEnter(clientKey)) {
      sendJson(res, 429, { error: '前の返事を待ってから、もう一度送ってください。' });
      return true;
    }
    try {
      return await routeApiRequest(req, res, url);
    } finally {
      geminiConcurrency.leave(clientKey);
    }
  }
  return routeApiRequest(req, res, url);
}

/** 確認を通ったリクエストを、それぞれのAPIに振り分ける */
async function routeApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<boolean> {

  try {
    if (req.method === 'GET' && url === '/api/status') {
      sendJson(res, 200, getAiConnectionStatus());
      return true;
    }

    if (req.method === 'GET' && url === '/api/aggregate-stats') {
      sendJson(res, 200, await getPublicAggregateStats());
      return true;
    }

    if (req.method === 'POST' && url === '/api/decision') {
      const body = await readJsonBody<RecordDecisionRequest>(req);
      if (
        !body?.stage ||
        !VALID_DECISION_STAGES.has(body.stage) ||
        typeof body.targetId !== 'string' ||
        !body.targetId.trim() ||
        typeof body.chosenLabel !== 'string' ||
        !body.chosenLabel.trim()
      ) {
        sendJson(res, 400, { error: '有効な stage, targetId, chosenLabel が必要です' });
        return true;
      }
      // 判断の記録に残すのは決まった値だけ。自由に書かれた理由は受け取らない
      const result = await recordHumanDecisionWithFunctionCalling({
        stage: body.stage,
        targetId: body.targetId.slice(0, 80),
        chosenLabel: body.chosenLabel.slice(0, 80),
        reason: '',
        cohortId: sanitizeCohortId(body.cohortId),
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/chat') {
      const body = await readJsonBody<ChatRequest>(req);
      if (!isValidAppSpec(body?.currentSpec) || typeof body.userMessage !== 'string') {
        sendJson(res, 400, { error: 'currentSpec と userMessage が必要です' });
        return true;
      }
      const userMessage = body.userMessage.slice(0, MAX_TEXT_INPUT_LENGTH);
      const history = sanitizeHistory(body.history);
      // Gemini に送る前に、個人情報やAIへの指示の乗っ取りが含まれていないかを調べる。
      // 履歴の学習者の発言も調べ、画面を通さずに送られた履歴から乗っ取られないようにする
      await assertPromptAllowed(learnerTextsForScreening(userMessage, history));
      const result = await chatWithStudio({
        ...body,
        runId: sanitizeRunId(body.runId),
        cohortId: sanitizeCohortId(body.cohortId),
        turnIndex: sanitizeTurnIndex(body.turnIndex),
        shareForAggregate: body.shareForAggregate === true,
        userMessage,
        history,
        latestReviews: sanitizeLatestReviews(body.latestReviews),
        targetComponentIds: sanitizeComponentIds(body.targetComponentIds),
        recipient: typeof body.recipient === 'string' ? body.recipient.slice(0, 40) : undefined,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/apply') {
      const body = await readJsonBody<ApplyRequest>(req);
      if (
        !isValidAppSpec(body?.currentSpec) ||
        typeof body.userInstruction !== 'string' ||
        !body.userInstruction.trim()
      ) {
        sendJson(res, 400, { error: 'currentSpec と手直し内容が必要です' });
        return true;
      }
      const userInstruction = body.userInstruction.slice(0, MAX_TEXT_INPUT_LENGTH);
      const history = sanitizeHistory(body.history);
      await assertPromptAllowed(learnerTextsForScreening(userInstruction, history));
      const result = await applyOptionToSpec({
        ...body,
        runId: sanitizeRunId(body.runId),
        cohortId: sanitizeCohortId(body.cohortId),
        turnIndex: sanitizeTurnIndex(body.turnIndex),
        shareForAggregate: body.shareForAggregate === true,
        userInstruction,
        history,
        targetComponentIds: sanitizeComponentIds(body.targetComponentIds),
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/run-event') {
      const body = await readJsonBody<Partial<RunEventInput>>(req);
      const reasons = ['cleared', 'reset', 'closed', 'idle'] as const;
      const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 10_000;
      const runId = sanitizeRunId(body?.runId);
      if (!runId || (body.eventType !== 'start' && body.eventType !== 'end')) {
        sendJson(res, 400, { error: 'runId と eventType が必要です' });
        return true;
      }
      // 決まった値だけを取り出して送る。自由に書ける文字列は受け取らない
      await recordRunEvent({
        runId,
        eventType: body.eventType,
        endReason: reasons.find((r) => r === body.endReason),
        cohortId: sanitizeCohortId(body.cohortId),
        scenario: typeof body.scenario === 'string' && /^[a-z_:]{1,30}$/.test(body.scenario) ? body.scenario : undefined,
        turnCount: isCount(body.turnCount) ? body.turnCount : undefined,
        achievedCount: isCount(body.achievedCount) ? body.achievedCount : undefined,
        totalCustomers: isCount(body.totalCustomers) ? body.totalCustomers : undefined,
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url === '/api/owner-line') {
      const body = await readJsonBody<OwnerLineRequest>(req);
      if (
        !body?.situation ||
        !VALID_OWNER_SITUATIONS.has(body.situation) ||
        !Array.isArray(body.facts) ||
        typeof body.fallback !== 'string'
      ) {
        sendJson(res, 400, { error: 'situation, facts, fallback が必要です' });
        return true;
      }
      const userMessage =
        typeof body.userMessage === 'string'
          ? body.userMessage.slice(0, MAX_TEXT_INPUT_LENGTH)
          : undefined;
      const history = sanitizeHistory(body.history);
      if (userMessage || history.some((e) => e.speaker === 'ユーザー')) {
        await assertPromptAllowed(learnerTextsForScreening(userMessage ?? '', history));
      }
      const facts = body.facts
        .filter((f): f is string => typeof f === 'string')
        .slice(0, 12)
        .map((f) => f.slice(0, 200));
      sendJson(
        res,
        200,
        await voiceOwnerLine({
          situation: body.situation,
          facts,
          fallback: body.fallback.slice(0, 200),
          userMessage,
          history,
        }),
      );
      return true;
    }

    if (req.method === 'POST' && url === '/api/evaluate') {
      const body = await readJsonBody<EvaluateRequest>(req);
      if (!isValidAppSpec(body?.currentSpec)) {
        sendJson(res, 400, { error: 'currentSpec が必要です' });
        return true;
      }
      const result = await evaluateAppWithPersonas({
        ...body,
        runId: sanitizeRunId(body.runId),
        cohortId: sanitizeCohortId(body.cohortId),
        history: sanitizeHistory(body.history),
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/tts') {
      const body = await readJsonBody<TtsRequest>(req);
      if (typeof body?.text !== 'string' || !body.text.trim()) {
        sendJson(res, 400, { error: 'text が必要です' });
        return true;
      }
      const result = await synthesizeStudioSpeech({
        text: body.text.slice(0, 400),
        speaker: typeof body.speaker === 'string' ? body.speaker.slice(0, 40) : 'assistant',
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/transcribe') {
      const body = await readJsonBody<TranscribeRequest>(req);
      if (
        typeof body?.audioBase64 !== 'string' ||
        !body.audioBase64.trim() ||
        !isValidAppSpec(body.currentSpec)
      ) {
        sendJson(res, 400, { error: 'audioBase64 と currentSpec が必要です' });
        return true;
      }
      const result = await transcribeAndRefineUserAudio({
        ...body,
        targetComponentIds: sanitizeComponentIds(body.targetComponentIds),
      });
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 404, { error: `未対応のAPIエンドポイントです: ${req.method} ${url}` });
    return true;
  } catch (err) {
    if (err instanceof DailyLimitError) {
      sendJson(res, err.statusCode, { error: err.message, code: err.code });
      return true;
    }
    if (err instanceof PromptRejectedError) {
      // 止めた理由の種類だけを返す。発言そのものは返さず、ログにも残さない
      sendJson(res, err.statusCode, { error: err.message, code: err.code, reason: err.reason });
      return true;
    }
    if (err instanceof PayloadTooLargeError) {
      // 残りの本文は読まずに、返事を送ったら接続を閉じる
      sendJson(res, err.statusCode, { error: err.message }, { Connection: 'close' });
      return true;
    }
    if (err instanceof AiNotConfiguredError || err instanceof AiTimeoutError) {
      sendJson(res, err.statusCode, { error: err.message });
      return true;
    }
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: 'JSONの形式が正しくありません' });
      return true;
    }
    // 原因は開発者向けにログへ残し、学習者には分かる言葉だけを返す
    console.error('[api] リクエスト処理に失敗しました:', describeErrorForLog(err));
    sendJson(res, 500, {
      error: 'お助けAIがうまく返事できませんでした。もう一度送ってください。',
    });
    return true;
  }
}
