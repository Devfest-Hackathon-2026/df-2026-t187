import type { IncomingMessage } from 'node:http';
import type { HumanDecisionRecord } from '../shared/types.ts';

const MAX_IN_MEMORY_DECISIONS = 200;
const inMemoryDecisions: HumanDecisionRecord[] = [];

/**
 * Firebase App Check トークンの検証（FIREBASE_APP_CHECK_ENFORCE=1 設定時のみ強制）。
 */
export function verifyAppCheckHeader(req: IncomingMessage): boolean {
  if (process.env.FIREBASE_APP_CHECK_ENFORCE !== '1') {
    return true;
  }
  const token = req.headers['x-firebase-appcheck'];
  return typeof token === 'string' && token.trim().length > 0;
}

/**
 * 人間の判断記録 (Own the Why) を保存する。
 * Cloud Firestore 環境が構成されている場合は REST 経由で送信を試み、インメモリにも保持する。
 */
export async function saveHumanDecision(
  decision: HumanDecisionRecord,
): Promise<{ persistedToFirestore: boolean }> {
  inMemoryDecisions.push(decision);
  if (inMemoryDecisions.length > MAX_IN_MEMORY_DECISIONS) {
    inMemoryDecisions.splice(0, inMemoryDecisions.length - MAX_IN_MEMORY_DECISIONS);
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const firestoreEnabled = process.env.FIRESTORE_ENABLED === '1' && Boolean(project);
  if (!firestoreEnabled) {
    return { persistedToFirestore: false };
  }

  try {
    const endpoint = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/decisions?documentId=${encodeURIComponent(decision.id)}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          stage: { stringValue: decision.stage },
          targetId: { stringValue: decision.targetId },
          chosenLabel: { stringValue: decision.chosenLabel },
          reason: { stringValue: decision.reason },
          recordedVia: { stringValue: decision.recordedVia },
          createdAt: { stringValue: decision.createdAt },
        },
      }),
    });
    return { persistedToFirestore: res.ok };
  } catch {
    return { persistedToFirestore: false };
  }
}

export function listHumanDecisions(): HumanDecisionRecord[] {
  return [...inMemoryDecisions];
}
