import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApplyRequest,
  ChatRequest,
  EvaluateRequest,
  ProposeRequest,
  RecordDecisionRequest,
} from '../shared/types.ts';
import {
  applyOptionToSpec,
  chatWithStudio,
  evaluateAppWithPersonas,
  getAiConnectionStatus,
  proposeTradeoffs,
  recordHumanDecisionWithFunctionCalling,
} from './gemini.ts';
import { listHumanDecisions, verifyAppCheckHeader } from './store.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB (ペン描きスクリーンショットBase64対応)

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('リクエストサイズが上限を超えています'));
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

    if (req.method === 'POST' && url === '/api/propose') {
      const body = await readJsonBody<ProposeRequest>(req);
      if (!body?.currentSpec || typeof body.userInstruction !== 'string') {
        sendJson(res, 400, { error: 'currentSpec と userInstruction が必要です' });
        return true;
      }
      const result = await proposeTradeoffs(body);
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && url === '/api/apply') {
      const body = await readJsonBody<ApplyRequest>(req);
      if (!body?.currentSpec || !body?.selectedOption) {
        sendJson(res, 400, { error: 'currentSpec と selectedOption が必要です' });
        return true;
      }
      const result = await applyOptionToSpec(body);
      sendJson(res, 200, result);
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

    sendJson(res, 404, { error: `未対応のAPIエンドポイントです: ${req.method} ${url}` });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'サーバー内部エラーが発生しました';
    sendJson(res, 500, { error: message });
    return true;
  }
}
