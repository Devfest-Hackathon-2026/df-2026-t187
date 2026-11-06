import { GoogleAuth } from 'google-auth-library';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { HumanDecisionRecord, TtsRequest, TtsResponse } from '../shared/types.ts';

const MAX_IN_MEMORY_DECISIONS = 200;
const inMemoryDecisions: HumanDecisionRecord[] = [];
const MAX_TTS_CACHE_ENTRIES = 300;
const ttsAudioCache = new Map<string, string>();
let presetsLoaded = false;

function ensureTtsPresetsLoaded(): void {
  if (presetsLoaded) return;
  presetsLoaded = true;
  try {
    const presetUrl = new URL('./ttsPresets.json', import.meta.url);
    if (!existsSync(presetUrl)) return;
    const raw = JSON.parse(readFileSync(presetUrl, 'utf-8')) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.length > 0) {
        ttsAudioCache.set(k, v);
      }
    }
  } catch {
    // プリセットの読み込みに失敗しても通常のTTS合成へフォールバックする
  }
}

let googleAuth: GoogleAuth | null = null;

async function getGcpAccessToken(): Promise<string | null> {
  try {
    if (!googleAuth) {
      googleAuth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    }
    const token = await googleAuth.getAccessToken();
    return token ?? null;
  } catch {
    return null;
  }
}

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
 * Cloud Firestore 環境が構成されている場合は ADC トークン付き REST 経由で送信し、インメモリにも保持する。
 */
export async function saveHumanDecision(
  decision: HumanDecisionRecord,
): Promise<{ persistedToFirestore: boolean }> {
  inMemoryDecisions.push(decision);
  if (inMemoryDecisions.length > MAX_IN_MEMORY_DECISIONS) {
    inMemoryDecisions.splice(0, inMemoryDecisions.length - MAX_IN_MEMORY_DECISIONS);
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const firestoreEnabled =
    process.env.FIRESTORE_ENABLED !== '0' &&
    Boolean(project) &&
    project !== 'your-gcp-project-id';
  if (!firestoreEnabled) {
    return { persistedToFirestore: false };
  }

  try {
    const token = await getGcpAccessToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const endpoint = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project ?? '')}/databases/(default)/documents/decisions?documentId=${encodeURIComponent(decision.id)}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
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

const SPEAKER_VOICE_MAP: Record<
  string,
  { name: string; pitch?: number; speakingRate: number }
> = {
  // 全11キャラクターにすべて別々の音声モデルを割り当て、同じ声が複数役にならないようにする
  // 店長：気の良い中年の男性店長
  owner: { name: 'ja-JP-Chirp3-HD-Charon', speakingRate: 1.02 },
  // お助けAI：ハキハキと聞き取りやすいアシスタント
  assistant: { name: 'ja-JP-Chirp3-HD-Aoede', speakingRate: 1.08 },
  // 確実に買いたい人（シニア層3人）
  kazuko: { name: 'ja-JP-Wavenet-B', pitch: -4.0, speakingRate: 0.92 }, // 74歳おばあちゃん
  shigeru: { name: 'ja-JP-Neural2-D', pitch: -5.5, speakingRate: 0.92 }, // 78歳おじいちゃん
  harue: { name: 'ja-JP-Chirp3-HD-Sulafat', speakingRate: 0.95 }, // 71歳主婦
  // さっと買いたい人（忙しい会社員3人）
  kenta: { name: 'ja-JP-Chirp3-HD-Fenrir', speakingRate: 1.18 }, // 34歳男性会社員
  misaki: { name: 'ja-JP-Chirp3-HD-Kore', speakingRate: 1.14 }, // 29歳女性会社員
  takumi: { name: 'ja-JP-Chirp3-HD-Orus', speakingRate: 1.1 }, // 41歳男性会社員
  // 損をしたくない人（大学生3人）
  shota: { name: 'ja-JP-Chirp3-HD-Puck', speakingRate: 1.08 }, // 20歳男子大学生
  hina: { name: 'ja-JP-Chirp3-HD-Leda', speakingRate: 1.12 }, // 19歳女子大学生
  ren: { name: 'ja-JP-Chirp3-HD-Schedar', speakingRate: 1.06 }, // 22歳男子大学生
};

const MAX_TTS_TEXT_LENGTH = 500;

/**
 * Google Cloud Text-to-Speech API を使って、店長・お助けAI・客A〜Cそれぞれの声色で音声合成する。
 */
export async function synthesizeStudioSpeech(req: TtsRequest): Promise<TtsResponse> {
  const text = (typeof req.text === 'string' ? req.text.trim() : '').slice(0, MAX_TTS_TEXT_LENGTH);
  if (!text) return { fallbackBrowserTts: true };
  const speaker =
    typeof req.speaker === 'string' && Object.hasOwn(SPEAKER_VOICE_MAP, req.speaker)
      ? req.speaker
      : 'assistant';

  ensureTtsPresetsLoaded();
  const cacheKey = `${speaker}::${text}`;
  const cached = ttsAudioCache.get(cacheKey);
  if (cached) {
    return { audioContent: cached };
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project || project === 'your-gcp-project-id') {
    return { fallbackBrowserTts: true };
  }

  const token = await getGcpAccessToken();
  if (!token) {
    return { fallbackBrowserTts: true };
  }

  const profile = SPEAKER_VOICE_MAP[speaker];
  const audioConfig: { audioEncoding: 'MP3'; speakingRate: number; pitch?: number } = {
    audioEncoding: 'MP3',
    speakingRate: profile.speakingRate,
  };
  if (profile.pitch !== undefined) {
    audioConfig.pitch = profile.pitch;
  }
  try {
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': project,
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: 'ja-JP',
          name: profile.name,
        },
        audioConfig,
      }),
    });
    if (!res.ok) {
      return { fallbackBrowserTts: true };
    }
    const data = (await res.json()) as { audioContent?: string };
    if (data.audioContent) {
      if (ttsAudioCache.size >= MAX_TTS_CACHE_ENTRIES) {
        const oldestKey = ttsAudioCache.keys().next().value;
        if (oldestKey) ttsAudioCache.delete(oldestKey);
      }
      ttsAudioCache.set(cacheKey, data.audioContent);
      return { audioContent: data.audioContent };
    }
    return { fallbackBrowserTts: true };
  } catch {
    return { fallbackBrowserTts: true };
  }
}
