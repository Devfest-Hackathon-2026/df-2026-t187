import { GoogleAuth } from 'google-auth-library';
import { existsSync, readFileSync } from 'node:fs';
import {
  classifyDeterministicArchetype,
  cosineSimilarity,
  extractDeterministicNlSignal,
  limitEntitiesToVocabulary,
  summarizePromptTelemetry,
} from '../shared/promptTelemetry.ts';
import type {
  EmbeddingSignal,
  HumanDecisionRecord,
  NaturalLanguageSignal,
  PromptArchetype,
  PromptSessionMode,
  PromptSessionSummary,
  PromptTelemetryEvent,
  TargetCohortId,
  TtsRequest,
  TtsResponse,
} from '../shared/types.ts';

const MAX_IN_MEMORY_TELEMETRY = 300;
const inMemoryTelemetryEvents: PromptTelemetryEvent[] = [];
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

export async function getGcpAccessToken(): Promise<string | null> {
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
 * 人間の判断記録 (Own the Why) を保存する。
 * Cloud Firestore 環境が構成されている場合は ADC トークン付き REST 経由で送信する。
 * 保存するのは決まった値だけで、サーバーのメモリには残さない。
 */
export async function saveHumanDecision(
  decision: HumanDecisionRecord,
): Promise<{ persistedToFirestore: boolean }> {
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

const ARCHETYPE_ANCHOR_TEXTS: Record<PromptArchetype, string> = {
  simple_delete: '定期便やクーポンや広告の欄をそのまま消して削除してなくして',
  condition_design:
    '初期チェックを外して自分で選べるようにして解約条件を分かりやすく明記して閉じるボタンを大きく下に配置して',
  direct_fix: '注文ボタンが動くように直して合計金額の数字を読みやすく変更して',
  vague_delegate: 'いい感じに全部まとめて使いやすく見やすく直しておまかせで',
  goal_directed:
    '定期便を望むお客さんだけが自分で選べるようにしたい クーポンを使いたい人が迷わず使えるようにして',
  inquiry: '店長やお客さんにどこで困ったか理由や狙いを質問して教えて',
};

let cachedAnchorEmbeddings: Map<PromptArchetype, number[]> | null = null;

/**
 * Cloud Natural Language API (`documents:annotateText`) を用いて指示文のエンティティと感情極性を抽出する。
 * GCP 未設定または通信失敗時は決定論的抽出へフォールバックする。
 */
export async function analyzePromptWithCloudNaturalLanguage(
  promptText: string,
): Promise<NaturalLanguageSignal> {
  const base = extractDeterministicNlSignal(promptText);
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project || project === 'your-gcp-project-id' || !promptText.trim()) {
    return base;
  }

  try {
    const token = await getGcpAccessToken();
    if (!token) return base;

    const res = await fetch('https://language.googleapis.com/v1/documents:annotateText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': project,
      },
      body: JSON.stringify({
        document: {
          type: 'PLAIN_TEXT',
          language: 'ja',
          content: promptText.slice(0, 500),
        },
        features: {
          extractEntities: true,
          extractDocumentSentiment: true,
        },
        encodingType: 'UTF8',
      }),
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return base;

    const data = (await res.json()) as {
      entities?: Array<{ name?: string }>;
      documentSentiment?: { score?: number };
    };

    // 取り出した語は題材の語彙に限る。人名などが混ざっても残さない
    const mergedEntities = limitEntitiesToVocabulary([
      ...base.entities,
      ...(data.entities ?? []).map((ent) => ent.name?.trim() ?? '').filter(Boolean),
    ]);

    const sentimentScore =
      typeof data.documentSentiment?.score === 'number'
        ? Number(data.documentSentiment.score.toFixed(2))
        : base.sentimentScore;

    return {
      entities: mergedEntities.slice(0, 8),
      hasConditionConstraint: base.hasConditionConstraint,
      sentimentScore,
      analyzedVia: 'cloud_natural_language_api',
    };
  } catch {
    return base;
  }
}

/**
 * 指示の型（目的つき / 単純削除 / 条件設計 / 具体修正 / 丸投げ / 探索）を分類する。
 * 型の定義はコードの規則で決める。規則に当てはまらず既定の具体修正に落ちた実行指示だけ、
 * Gemini Enterprise Agent Platform の Text embeddings API (`text-multilingual-embedding-002`) で典型的な指示とのコサイン類似度を見て、近い型で補う。
 * 埋め込みで常に上書きすると、近さが低い発言で規則どおりの型が覆ることがあったため（例：目的つきの指示が丸投げになる）。
 */
export async function classifyPromptWithAgentPlatformEmbeddings(
  promptText: string,
  sessionMode: PromptSessionMode,
): Promise<EmbeddingSignal> {
  const base = classifyDeterministicArchetype(promptText, sessionMode);
  if (sessionMode !== 'execute' || base.closestArchetype !== 'direct_fix') {
    return base;
  }
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project || project === 'your-gcp-project-id' || !promptText.trim()) {
    return base;
  }

  try {
    const token = await getGcpAccessToken();
    if (!token) return base;

    const rawLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const location = rawLocation === 'global' ? 'us-central1' : rawLocation;
    const endpoint = `https://${encodeURIComponent(location)}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/text-multilingual-embedding-002:predict`;

    const archetypes = Object.keys(ARCHETYPE_ANCHOR_TEXTS) as PromptArchetype[];
    const needAnchors = !cachedAnchorEmbeddings;
    const instances = needAnchors
      ? [
          { content: promptText.slice(0, 500) },
          ...archetypes.map((k) => ({ content: ARCHETYPE_ANCHOR_TEXTS[k] })),
        ]
      : [{ content: promptText.slice(0, 500) }];

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ instances }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return base;

    const data = (await res.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };
    const vectors = (data.predictions ?? []).map((p) => p.embeddings?.values ?? []);
    if (vectors.length === 0 || vectors[0].length === 0) return base;

    const promptVector = vectors[0];
    if (needAnchors && vectors.length === archetypes.length + 1) {
      const map = new Map<PromptArchetype, number[]>();
      for (let i = 0; i < archetypes.length; i++) {
        if (vectors[i + 1].length > 0) {
          map.set(archetypes[i], vectors[i + 1]);
        }
      }
      if (map.size === archetypes.length) {
        cachedAnchorEmbeddings = map;
      }
    }

    if (!cachedAnchorEmbeddings) return base;

    let bestArchetype: PromptArchetype = base.closestArchetype;
    let bestScore = -1;
    for (const [arch, vec] of cachedAnchorEmbeddings.entries()) {
      if (arch === 'inquiry') continue;
      const sim = cosineSimilarity(promptVector, vec);
      if (sim > bestScore) {
        bestScore = sim;
        bestArchetype = arch;
      }
    }

    return {
      closestArchetype: bestArchetype,
      similarityScore: bestScore > 0 ? bestScore : base.similarityScore,
      analyzedVia: 'agent_platform_embedding',
    };
  } catch {
    return base;
  }
}

/** BigQuery のテーブルに行を送る。失敗しても体験は止めない。待たずに返すときは呼び出し側で void する */
async function insertBigQueryRows(
  project: string,
  token: string,
  table: string,
  rows: Array<{ insertId: string; json: Record<string, unknown> }>,
): Promise<void> {
  const dataset = process.env.BIGQUERY_DATASET || 'studio_telemetry';
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}/insertAll`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      kind: 'bigquery#tableDataInsertAllRequest',
      skipInvalidRows: true,
      ignoreUnknownValues: true,
      rows,
    }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});
}

/** Firestore の記録を自動で消すまでの時間。消す処理は Firestore の TTL ポリシーで expireAt を見て行う */
const TELEMETRY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 記録をクラウドに送る。指示の本文は送らない。
 * Firestore には、挑戦の振り返りに使う値を挑戦ごとの番号で一時的に置く（期限で自動的に消える）。
 * BigQuery には、学習者が集計に加えることに同意した挑戦の値だけを送る
 */
async function persistTelemetryToCloud(event: PromptTelemetryEvent, shareForAggregate: boolean): Promise<void> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project || project === 'your-gcp-project-id') return;

  try {
    const token = await getGcpAccessToken();
    if (!token) return;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // 1. Cloud Firestore への保存
    if (process.env.FIRESTORE_ENABLED !== '0') {
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents/prompt_telemetry?documentId=${encodeURIComponent(event.id)}`;
      void fetch(firestoreUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fields: {
            cohortId: { stringValue: event.cohortId ?? '' },
            runId: { stringValue: event.runId ?? '' },
            turnIndex: { integerValue: String(event.turnIndex) },
            sessionMode: { stringValue: event.sessionMode },
            recipient: { stringValue: event.recipient },
            hasPenAnnotation: { booleanValue: event.hasPenAnnotation },
            changedComponentIds: { stringValue: event.changedComponentIds.join(',') },
            isReworkOnSameComponent: { booleanValue: event.isReworkOnSameComponent },
            removedNeededFeature: { booleanValue: event.removedNeededFeature },
            closestArchetype: { stringValue: event.embeddingSignal.closestArchetype },
            hasConditionConstraint: { booleanValue: event.nlSignal.hasConditionConstraint },
            entities: { stringValue: event.nlSignal.entities.join(',') },
            sentimentScore: { doubleValue: event.nlSignal.sentimentScore },
            createdAt: { stringValue: event.createdAt },
            expireAt: { timestampValue: new Date(Date.parse(event.createdAt) + TELEMETRY_TTL_MS).toISOString() },
          },
        }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    }

    // 2. BigQuery Streaming Insert への保存。集計に加えることに同意した挑戦だけ
    if (!shareForAggregate) return;
    void insertBigQueryRows(project, token, process.env.BIGQUERY_TABLE || 'prompt_events', [
      {
        insertId: event.id,
        json: {
          id: event.id,
          cohort_id: event.cohortId ?? null,
          run_id: event.runId ?? null,
          turn_index: event.turnIndex,
          session_mode: event.sessionMode,
          recipient: event.recipient,
          has_pen_annotation: event.hasPenAnnotation,
          changed_component_ids: event.changedComponentIds.join(','),
          is_rework_on_same_component: event.isReworkOnSameComponent,
          removed_needed_feature: event.removedNeededFeature,
          closest_archetype: event.embeddingSignal.closestArchetype,
          similarity_score: event.embeddingSignal.similarityScore,
          embedding_via: event.embeddingSignal.analyzedVia,
          entities: event.nlSignal.entities.join(','),
          has_condition_constraint: event.nlSignal.hasConditionConstraint,
          sentiment_score: event.nlSignal.sentimentScore,
          nl_via: event.nlSignal.analyzedVia,
          created_at: event.createdAt,
        },
      },
    ]);
  } catch {
    // クラウド送信エラー時はインメモリ記録を維持する
  }
}

export interface RunEventInput {
  runId: string;
  eventType: 'start' | 'end';
  endReason?: 'cleared' | 'reset' | 'closed' | 'idle';
  cohortId?: string;
  scenario?: string;
  turnCount?: number;
  achievedCount?: number;
  totalCustomers?: number;
}

/**
 * 挑戦の始まりと終わりを BigQuery に送る。画面は、集計に加えることに同意した挑戦のときだけ呼ぶ。
 * 途中でやめた挑戦も数えるため、終わり方（クリア・やり直し・タブを閉じた・操作がなかった）を残す。
 * 送るのは挑戦の番号と決まった値だけで、発言の本文や接続元は送らない
 */
export async function recordRunEvent(input: RunEventInput): Promise<void> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project || project === 'your-gcp-project-id') return;
  try {
    const token = await getGcpAccessToken();
    if (!token) return;
    await insertBigQueryRows(project, token, process.env.BIGQUERY_RUN_TABLE || 'run_events', [
      {
        insertId: `${input.runId}:${input.eventType}`,
        json: {
          run_id: input.runId,
          event_type: input.eventType,
          end_reason: input.endReason ?? null,
          cohort_id: input.cohortId ?? null,
          scenario: input.scenario ?? null,
          turn_count: input.turnCount ?? null,
          achieved_count: input.achievedCount ?? null,
          total_customers: input.totalCustomers ?? null,
          created_at: new Date().toISOString(),
        },
      },
    ]);
  } catch {
    // 記録に失敗しても体験は止めない
  }
}

/**
 * 学習者の1回の発言・指示を Cloud Natural Language API + Agent Platform の埋め込みで分析し、
 * 行動テレメトリとして記録する。
 */
export async function recordPromptTelemetryEvent(input: {
  cohortId?: TargetCohortId;
  runId?: string;
  /** その挑戦の中で何番目の発言か。ブラウザが数える */
  turnIndex?: number;
  /** 分析にだけ使い、記録には残さない */
  promptText: string;
  sessionMode: PromptSessionMode;
  recipient: string;
  hasPenAnnotation: boolean;
  changedComponentIds?: string[];
  removedNeededFeature?: boolean;
  /** 学習者が集計に加えることに同意した挑戦か。同意したときだけ BigQuery に送る */
  shareForAggregate?: boolean;
}): Promise<PromptTelemetryEvent> {
  const changedComponentIds = input.changedComponentIds ?? [];
  const priorExecuteEvents = inMemoryTelemetryEvents.filter(
    (e) =>
      e.sessionMode === 'execute' &&
      (input.runId
        ? e.runId === input.runId
        : !input.cohortId || !e.cohortId || e.cohortId === input.cohortId),
  );
  const previouslyTouchedIds = new Set(priorExecuteEvents.flatMap((e) => e.changedComponentIds));
  const isReworkOnSameComponent =
    input.sessionMode === 'execute' &&
    changedComponentIds.some((id) => previouslyTouchedIds.has(id));

  const [nlSignal, embeddingSignal] = await Promise.all([
    analyzePromptWithCloudNaturalLanguage(input.promptText),
    classifyPromptWithAgentPlatformEmbeddings(input.promptText, input.sessionMode),
  ]);

  const event: PromptTelemetryEvent = {
    id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    cohortId: input.cohortId,
    runId: input.runId,
    turnIndex: input.turnIndex ?? -1,
    sessionMode: input.sessionMode,
    recipient: input.recipient,
    hasPenAnnotation: input.hasPenAnnotation,
    changedComponentIds,
    isReworkOnSameComponent,
    removedNeededFeature: Boolean(input.removedNeededFeature),
    nlSignal,
    embeddingSignal,
    createdAt: new Date().toISOString(),
  };

  inMemoryTelemetryEvents.push(event);
  if (inMemoryTelemetryEvents.length > MAX_IN_MEMORY_TELEMETRY) {
    inMemoryTelemetryEvents.splice(0, inMemoryTelemetryEvents.length - MAX_IN_MEMORY_TELEMETRY);
  }

  void persistTelemetryToCloud(event, Boolean(input.shareForAggregate));
  return event;
}

/**
 * 顧客シミュレーション実行後、直近のテレメトリイベントに結果（何人満足したか・クリアしたか）を紐づけ、
 * 現在のコホートの集計サマリーを返す。
 */
export function finalizeTelemetryOnEvaluate(
  cohortId: TargetCohortId | undefined,
  achievedCount: number,
  totalCustomers: number,
  runId?: string,
): PromptSessionSummary {
  // 挑戦の番号があれば、その挑戦の記録だけで振り返る（やり直す前の挑戦や、ほかの人の記録を混ぜない）
  const events = runId
    ? inMemoryTelemetryEvents.filter((e) => e.runId === runId)
    : inMemoryTelemetryEvents;
  const latest = [...events]
    .reverse()
    .find((e) => !cohortId || !e.cohortId || e.cohortId === cohortId);
  if (latest) {
    latest.outcomeAfterTurn = {
      achievedCount,
      totalCustomers,
      passed: achievedCount === totalCustomers && totalCustomers > 0,
    };
  }
  return summarizePromptTelemetry(events, cohortId);
}

export function clearPromptTelemetryEvents(): void {
  inMemoryTelemetryEvents.length = 0;
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
      // 読み上げる文には、AIの返事を通して学習者の言葉が混ざることがあるので、合成した音声は覚えておかない。
      // 覚えておくのは、同梱した決まったせりふの音声だけ
      return { audioContent: data.audioContent };
    }
    return { fallbackBrowserTts: true };
  } catch {
    return { fallbackBrowserTts: true };
  }
}
