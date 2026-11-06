import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApplyRequest,
  ChatRequest,
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
import { listHumanDecisions, synthesizeStudioSpeech, verifyAppCheckHeader } from './store.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB (ペン描きスクリーンショットBase64対応)

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

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
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

  if (!verifyAppCheckHeader(req)) {
    sendJson(res, 401, { error: 'App Check トークンが必要です' });
    return true;
  }

  try {
    if (req.method === 'GET' && url === '/api/status') {
      sendJson(res, 200, getAiConnectionStatus());
      return true;
    }

    if (req.method === 'GET' && url === '/api/decisions') {
      sendJson(res, 200, { decisions: listHumanDecisions() });
      return true;
    }

    if (req.method === 'POST' && url === '/api/decision') {
      const body = await readJsonBody<RecordDecisionRequest>(req);
      if (!body?.stage || !body?.targetId || !body?.chosenLabel) {
        sendJson(res, 400, { error: 'stage, targetId, chosenLabel が必要です' });
        return true;
      }
      const result = await recordHumanDecisionWithFunctionCalling(body);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/chat') {
      const body = await readJsonBody<ChatRequest>(req);
      if (!body?.currentSpec || typeof body.userMessage !== 'string') {
        sendJson(res, 400, { error: 'currentSpec と userMessage が必要です' });
        return true;
      }
      const result = await chatWithStudio(body);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/apply') {
      const body = await readJsonBody<ApplyRequest>(req);
      if (!body?.currentSpec || !body?.userInstruction?.trim()) {
        sendJson(res, 400, { error: 'currentSpec と手直し内容が必要です' });
        return true;
      }
      const result = await applyOptionToSpec(body);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/owner-line') {
      const body = await readJsonBody<OwnerLineRequest>(req);
      if (!body?.situation || !Array.isArray(body.facts) || typeof body.fallback !== 'string') {
        sendJson(res, 400, { error: 'situation, facts, fallback が必要です' });
        return true;
      }
      sendJson(res, 200, await voiceOwnerLine(body));
      return true;
    }

    if (req.method === 'POST' && url === '/api/evaluate') {
      const body = await readJsonBody<EvaluateRequest>(req);
      if (!body?.currentSpec) {
        sendJson(res, 400, { error: 'currentSpec が必要です' });
        return true;
      }
      const result = await evaluateAppWithPersonas(body);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/tts') {
      const body = await readJsonBody<TtsRequest>(req);
      if (!body?.text) {
        sendJson(res, 400, { error: 'text が必要です' });
        return true;
      }
      const result = await synthesizeStudioSpeech(body);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/transcribe') {
      const body = await readJsonBody<TranscribeRequest>(req);
      if (!body?.audioBase64 || !body?.currentSpec) {
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
