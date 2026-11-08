import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApplyRequest,
  AppSpec,
  ChatRequest,
  DecisionStage,
  EvaluateRequest,
  OwnerLineRequest,
  RecordDecisionRequest,
  TranscribeRequest,
  TtsRequest,
} from '../shared/types.ts';
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
  synthesizeStudioSpeech,
} from './store.ts';
import { RateLimiter, clientKeyOf, rateLimitGroupOf } from './rateLimit.ts';

const apiRateLimiter = new RateLimiter();
// 使われなくなった接続元の記録を捨てる。サーバーの終了を妨げないよう unref する
setInterval(() => apiRateLimiter.prune(), 5 * 60_000).unref();

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB (ペン描きスクリーンショットBase64対応)
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

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
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

  // Gemini や読み上げを呼ぶAPIは、本文を読む前に回数の上限を確かめる
  const limitGroup = rateLimitGroupOf(req.method, url);
  if (limitGroup) {
    const taken = apiRateLimiter.take(limitGroup, clientKeyOf(req));
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

  try {
    if (req.method === 'GET' && url === '/api/status') {
      sendJson(res, 200, getAiConnectionStatus());
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
      const result = await recordHumanDecisionWithFunctionCalling({
        ...body,
        targetId: body.targetId.slice(0, 200),
        chosenLabel: body.chosenLabel.slice(0, 500),
        reason: typeof body.reason === 'string' ? body.reason.slice(0, MAX_TEXT_INPUT_LENGTH) : '',
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
      const result = await chatWithStudio({
        ...body,
        userMessage: body.userMessage.slice(0, MAX_TEXT_INPUT_LENGTH),
        targetComponentIds: Array.isArray(body.targetComponentIds)
          ? body.targetComponentIds.filter((id): id is string => typeof id === 'string').slice(0, 20)
          : [],
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
      const result = await applyOptionToSpec({
        ...body,
        userInstruction: body.userInstruction.slice(0, MAX_TEXT_INPUT_LENGTH),
        targetComponentIds: Array.isArray(body.targetComponentIds)
          ? body.targetComponentIds.filter((id): id is string => typeof id === 'string').slice(0, 20)
          : [],
      });
      sendJson(res, 200, result);
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
      sendJson(res, 200, await voiceOwnerLine(body));
      return true;
    }

    if (req.method === 'POST' && url === '/api/evaluate') {
      const body = await readJsonBody<EvaluateRequest>(req);
      if (!isValidAppSpec(body?.currentSpec)) {
        sendJson(res, 400, { error: 'currentSpec が必要です' });
        return true;
      }
      const result = await evaluateAppWithPersonas(body);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/tts') {
      const body = await readJsonBody<TtsRequest>(req);
      if (typeof body?.text !== 'string' || !body.text.trim()) {
        sendJson(res, 400, { error: 'text が必要です' });
        return true;
      }
      const result = await synthesizeStudioSpeech(body);
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
      const result = await transcribeAndRefineUserAudio(body);
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 404, { error: `未対応のAPIエンドポイントです: ${req.method} ${url}` });
    return true;
  } catch (err) {
    if (
      err instanceof AiNotConfiguredError ||
      err instanceof AiTimeoutError ||
      err instanceof PayloadTooLargeError
    ) {
      sendJson(res, err.statusCode, { error: err.message });
      return true;
    }
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: 'JSONの形式が正しくありません' });
      return true;
    }
    // 原因は開発者向けにログへ残し、学習者には分かる言葉だけを返す
    console.error('[api] リクエスト処理に失敗しました:', err);
    sendJson(res, 500, {
      error: 'お助けAIがうまく返事できませんでした。もう一度送ってください。',
    });
    return true;
  }
}
