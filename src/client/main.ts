import { detectHitComponents, type Point2D, type Rect2D } from '../shared/hitTest.ts';
import { createInitialState, hasCompletionAction, withDerivedValues } from '../shared/appRuntime.ts';
import {
  ACTIVE_THEME,
  ALL_REVIEWER_PERSONAS,
  getReviewersByCohort,
  TARGET_COHORTS,
} from '../shared/initialTheme.ts';
import {
  classifyUserMessageIntent,
  detectCheckpointRevertCommand,
  detectExplicitRecipientMention,
} from '../shared/intent.ts';
import { buildOwnerClosingLines } from '../shared/owner.ts';
import { simulatePersonaComputerUse } from '../shared/sandboxValidator.ts';
import { describeOtherCohortImpact, describeOtherCohortReport } from '../shared/otherCohorts.ts';
import { splitIntoChatChunks } from '../shared/chatText.ts';
import { buildInitialSpec, buildScenarioSpec, type DifficultyLevel } from '../shared/theme.ts';
import type {
  AppSpec,
  ChatHistoryEntry,
  ChatResponse,
  Checkpoint,
  EvaluationResponse,
  HumanDecisionRecord,
  LatestReviewRecord,
  OwnerLineRequest,
  OwnerLineResponse,
  RecordDecisionRequest,
  RecordDecisionResponse,
  ReviewerPersona,
  ReviewOutcome,
  StateValue,
  TargetCohortId,
  TranscribeResponse,
  TtsResponse,
} from '../shared/types.ts';
import { ICONS } from './icons.ts';
import {
  querySandboxComponentElements,
  renderSandboxApp,
  scrollSandboxBy,
} from './sandboxRenderer.ts';
import { captureSandboxSnapshot } from './snapshot.ts';

/**
 * チャットの発言者
 * - system: スマホ画面の操作通知・改造の作業ログ・エラー表示
 * - assistant: お助けエージェント（進行案内・事実の説明・改造の実行報告）
 * - customer: お客さん本人の発言（来店時の希望・反応確認時の感想・質問への返答）
 * - owner: 依頼主の店長（変更直後に売上・定期便の立場からリアクション・質問への返答）
 * - user: 学習者（改善の意思決定者）
 */
type MessageRole = 'system' | 'assistant' | 'customer' | 'owner' | 'user';

interface TimelineMessage {
  id: string;
  role: MessageRole;
  text: string;
  tone?: 'default' | 'warning';
  /** role が customer のときの発言者 */
  personaId?: string;
  showCohortSelector?: boolean;
  /** この選択肢で選ばれた顧客層 */
  chosenCohortId?: TargetCohortId;
  /** 次のお客さんチャレンジ等で選ばれた選択肢キー */
  chosenOption?: string;
  /** 改造完了後にチャット内からも「お客さんの反応を見る」を押せるようにする */
  showEvaluateAction?: boolean;
  /** この発言が対象にしている、赤ペンで囲んだ部品 */
  targetComponentIds?: string[];
  /** 改造の作業の過程。システムのメッセージとして1行ずつ進み、完了後もそのまま残す */
  workLog?: {
    steps: Array<{ text: string; done: boolean; componentId?: string }>;
    finished: boolean;
  };
  /** 赤ペンで囲んだことへのお助けエージェントの反応。囲み直したら置き換える */
  circleReaction?: boolean;
  /** お助けエージェントの回答に続けて押せる返信候補 */
  followUps?: string[];
  /** クリア後の「ほかのお客さんにもチャレンジしますか」の発言 */
  showNextChallenge?: boolean;
  /** お客さんの反応 */
  review?: {
    outcome: ReviewOutcome;
  };
}

interface StudioState {
  /** 3人全員が満足して買えた顧客層 */
  clearedCohortIds: TargetCohortId[];
  checkpoints: Checkpoint[];
  activeCheckpointIndex: number;
  liveAppState: Record<string, StateValue>;
  selectedCohortId?: TargetCohortId;
  decisions: HumanDecisionRecord[];
  interactionMode: 'play' | 'pen';
  penPoints: Point2D[];
  circledComponentIds: string[];
  /** 会話の話題になっている部品。囲み直すか改造するまで次の発言に引き継ぐ */
  topicTargetIds: string[];
  inputText: string;
  /** メッセージの宛先（assistant / owner / ペルソナID） */
  recipient: string;
  /** 書き込み中として表示している発言者（順番に出す演出用） */
  typingMessage?: Pick<TimelineMessage, 'role' | 'personaId'>;
  /** お助けエージェントが考え中に送ろうとした。返事が届いたら送る */
  pendingSend: boolean;
  /** 改造の作業ログを流している間、スマホで光らせる部品 */
  justChangedIds: string[];
  /** 選んだ3人が全員達成してレポートを出したあと。やり直すまで手直しは受け付けない */
  runFinished: boolean;
  /** 1回の挑戦ごとの番号。客層を選ぶたび・やり直すたびに新しくする */
  runId: string;
  chatLoading: boolean;
  evaluateLoading: boolean;
  /** Cloud TTS による音声読み上げのON/OFF */
  voiceEnabled: boolean;
  /** マイク音声入力の録音中フラグ */
  isRecordingAudio: boolean;
  /** 録音した音声をGeminiで整形・文字起こし中フラグ */
  isTranscribingAudio: boolean;
  messages: TimelineMessage[];
}

const OWNER = ACTIVE_THEME.owner;

function formatCheckpointLabel(cp: Pick<Checkpoint, 'stepNumber'>): string {
  return cp.stepNumber === 0 ? '最初' : `手直し${cp.stepNumber}`;
}

/**
 * 体験の画面を決める。
 * - 既定：題材の固定の問題（?scenario=名前 で別の問題も選べる）
 * - ?mode=random：妨害要素の組み合わせを毎回ランダムにする練習用。
 *   ?level=easy|normal|hard で壊れ方の多さを、?seed=数字 で組み合わせの固定を選べる
 * - ?clean：妨害要素を入れる前の画面（題材のデザイン調整用）
 */
function createSessionSpec(): AppSpec {
  const params = new URLSearchParams(window.location.search);
  if (params.has('clean')) {
    return structuredClone(ACTIVE_THEME.baseSpec);
  }
  if (params.get('mode') !== 'random') {
    const scenarioParam = params.get('scenario');
    const scenarioId =
      scenarioParam && ACTIVE_THEME.scenarios[scenarioParam]
        ? scenarioParam
        : ACTIVE_THEME.defaultScenarioId;
    return buildScenarioSpec(ACTIVE_THEME, scenarioId).spec;
  }
  const seedParam = Number(params.get('seed'));
  const seed = Number.isFinite(seedParam) && params.has('seed') ? seedParam : Date.now();
  const levelParam = params.get('level');
  const level: DifficultyLevel =
    levelParam === 'easy' || levelParam === 'hard' ? levelParam : 'normal';
  return buildInitialSpec(ACTIVE_THEME, seed, level).spec;
}

const INITIAL_SPEC = createSessionSpec();

const state: StudioState = {
  checkpoints: [
    {
      id: 'cp-0',
      stepNumber: 0,
      commitMessage: 'かいぞう前',
      createdAt: new Date().toISOString(),
      spec: INITIAL_SPEC,
    },
  ],
  activeCheckpointIndex: 0,
  liveAppState: createInitialState(INITIAL_SPEC),
  selectedCohortId: undefined,
  clearedCohortIds: [],
  decisions: [],
  interactionMode: 'play',
  penPoints: [],
  circledComponentIds: [],
  topicTargetIds: [],
  inputText: '',
  recipient: 'assistant',
  typingMessage: undefined,
  pendingSend: false,
  justChangedIds: [],
  runFinished: false,
  runId: '',
  chatLoading: false,
  evaluateLoading: false,
  voiceEnabled: true,
  isRecordingAudio: false,
  isTranscribingAudio: false,
  messages: [],
};

function getCurrentCheckpoint(): Checkpoint {
  return state.checkpoints[state.activeCheckpointIndex] ?? state.checkpoints[0];
}

/** その画面で、いま選んでいる顧客層のお客さんに反応を見てもらった結果。別の顧客層の結果は使わない */
function evaluationFor(cp: Checkpoint | undefined): EvaluationResponse | undefined {
  const evaluation = cp?.evaluation;
  return evaluation && evaluation.cohortId === state.selectedCohortId ? evaluation : undefined;
}

function getCurrentSpec(): AppSpec {
  return getCurrentCheckpoint().spec;
}

/** 指定した番号以前で、いま選んでいる顧客層のお客さんの反応を見た一番新しい記録を探す */
function findLatestCohortEvaluation(
  fromIndex: number = state.activeCheckpointIndex,
): { checkpoint: Checkpoint; index: number; evaluation: EvaluationResponse } | undefined {
  for (let i = fromIndex; i >= 0; i--) {
    const cp = state.checkpoints[i];
    const evaluation = evaluationFor(cp);
    if (evaluation) {
      return { checkpoint: cp, index: i, evaluation };
    }
  }
  return undefined;
}

/** 今の画面か、それより前で一番新しくお客さんの反応を見た画面の、操作の記録 */
function buildLatestReviewRecord(): LatestReviewRecord | undefined {
  const found = findLatestCohortEvaluation();
  if (!found) return undefined;
  const { checkpoint: cp, index: i, evaluation } = found;
  return {
    screenLabel: formatCheckpointLabel(cp),
    isCurrentScreen: i === state.activeCheckpointIndex,
    reviews: evaluation.results.map((r) => ({
      name: findPersona(r.reviewerId)?.name ?? r.reviewerId,
      outcome: r.outcome,
      actionTrace: r.actionTrace ?? [],
    })),
    ownerMetrics: evaluation.owner?.metrics,
  };
}

function findPersona(personaId: string | undefined): ReviewerPersona | undefined {
  if (!personaId) return undefined;
  return ALL_REVIEWER_PERSONAS.find((p) => p.id === personaId);
}

let currentAudioEl: HTMLAudioElement | null = null;
const ttsPlaybackQueue: Array<{
  text: string;
  speaker: string;
  onDone?: () => void;
}> = [];
let isPlayingTts = false;
let currentTtsDoneResolver: (() => void) | null = null;
const ttsPrefetchCache = new Map<string, Promise<TtsResponse>>();

/** ブラウザ標準TTSフォールバック時も全11キャラクターで高さと速さを変える */
const BROWSER_VOICE_PROFILES: Record<string, { pitch: number; rate: number }> = {
  owner: { pitch: 0.75, rate: 1.0 },
  assistant: { pitch: 1.15, rate: 1.12 },
  kazuko: { pitch: 0.82, rate: 0.9 },
  shigeru: { pitch: 0.65, rate: 0.9 },
  harue: { pitch: 0.95, rate: 0.95 },
  kenta: { pitch: 0.92, rate: 1.2 },
  misaki: { pitch: 1.08, rate: 1.15 },
  takumi: { pitch: 0.82, rate: 1.1 },
  shota: { pitch: 1.02, rate: 1.08 },
  hina: { pitch: 1.28, rate: 1.14 },
  ren: { pitch: 0.86, rate: 1.05 },
};

function isSpokenMessage(msg: Pick<TimelineMessage, 'role' | 'text'>): boolean {
  return (
    Boolean(msg.text.trim()) &&
    (msg.role === 'assistant' || msg.role === 'owner' || msg.role === 'customer')
  );
}

function speakerOfMessage(msg: Pick<TimelineMessage, 'role' | 'personaId'>): string {
  return msg.role === 'customer' ? (msg.personaId ?? 'assistant') : msg.role;
}

function fetchTtsAudio(text: string, speaker: string): Promise<TtsResponse> {
  const trimmed = text.trim();
  const key = `${speaker}::${trimmed}`;
  const cached = ttsPrefetchCache.get(key);
  if (cached) return cached;
  const promise = postJson<TtsResponse>('/api/tts', {
    text: trimmed,
    speaker,
  }).catch(() => {
    ttsPrefetchCache.delete(key);
    return { fallbackBrowserTts: true };
  });
  ttsPrefetchCache.set(key, promise);
  return promise;
}

function stopAllTtsPlayback(): void {
  while (ttsPlaybackQueue.length > 0) {
    const item = ttsPlaybackQueue.shift();
    item?.onDone?.();
  }
  isPlayingTts = false;
  if (currentAudioEl) {
    currentAudioEl.pause();
    currentAudioEl = null;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  if (currentTtsDoneResolver) {
    const resolve = currentTtsDoneResolver;
    currentTtsDoneResolver = null;
    resolve();
  }
}

async function processNextTtsInQueue(): Promise<void> {
  if (isPlayingTts || !state.voiceEnabled) {
    if (!state.voiceEnabled) {
      while (ttsPlaybackQueue.length > 0) {
        ttsPlaybackQueue.shift()?.onDone?.();
      }
    }
    return;
  }
  const next = ttsPlaybackQueue.shift();
  if (!next) return;
  isPlayingTts = true;
  try {
    const res = await fetchTtsAudio(next.text, next.speaker);
    if (!state.voiceEnabled) {
      next.onDone?.();
      isPlayingTts = false;
      return;
    }
    if (res.audioContent) {
      await new Promise<void>((resolve) => {
        const audio = new Audio(`data:audio/mp3;base64,${res.audioContent}`);
        currentAudioEl = audio;
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          if (currentAudioEl === audio) currentAudioEl = null;
          if (currentTtsDoneResolver === done) currentTtsDoneResolver = null;
          resolve();
        };
        currentTtsDoneResolver = done;
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        audio.play().catch(done);
      });
    } else if ('speechSynthesis' in window) {
      await new Promise<void>((resolve) => {
        const utter = new SpeechSynthesisUtterance(next.text);
        utter.lang = 'ja-JP';
        const profile = BROWSER_VOICE_PROFILES[next.speaker] ?? BROWSER_VOICE_PROFILES.assistant;
        utter.pitch = profile.pitch;
        utter.rate = profile.rate;
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          if (currentTtsDoneResolver === done) currentTtsDoneResolver = null;
          resolve();
        };
        currentTtsDoneResolver = done;
        utter.addEventListener('end', done, { once: true });
        utter.addEventListener('error', done, { once: true });
        window.speechSynthesis.speak(utter);
      });
    }
  } catch {
    // 音声合成失敗時は静かにスキップ
  } finally {
    next.onDone?.();
    isPlayingTts = false;
    if (state.voiceEnabled && ttsPlaybackQueue.length > 0) {
      void processNextTtsInQueue();
    }
  }
}

function playCloudTtsForMessage(msg: TimelineMessage, onDone?: () => void): void {
  if (!state.voiceEnabled || !isSpokenMessage(msg)) {
    onDone?.();
    return;
  }
  const speaker = speakerOfMessage(msg);
  ttsPlaybackQueue.push({ text: msg.text, speaker, onDone });
  void processNextTtsInQueue();
}

function playTtsAndWait(msg: TimelineMessage): Promise<void> {
  if (!state.voiceEnabled || !isSpokenMessage(msg)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(safetyTimer);
      resolve();
    };
    // 万一ブラウザの音声再生イベントが返らない場合でも12秒で次へ進める安全弁
    const safetyTimer = window.setTimeout(finish, 12_000);
    playCloudTtsForMessage(msg, finish);
  });
}

function pushMessage(
  msg: Omit<TimelineMessage, 'id'>,
  options?: { skipAutoTts?: boolean },
): TimelineMessage {
  const full: TimelineMessage = {
    id: `${msg.role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...msg,
  };
  state.messages.push(full);
  if (!options?.skipAutoTts) {
    playCloudTtsForMessage(full);
  }
  return full;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `通信エラーが発生しました (${res.status})`);
  }
  return data;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : '通信に失敗しました';
}

const appRoot = document.getElementById('app');
if (!appRoot) {
  throw new Error('#app element not found');
}

let shellEl: HTMLElement | null = null;
let headerSlotEl: HTMLElement | null = null;
let phoneFrameEl: HTMLElement | null = null;
let sandboxStageEl: HTMLElement | null = null;
let sandboxAppMountEl: HTMLElement | null = null;
let penCanvasEl: HTMLCanvasElement | null = null;
let bottomBarEl: HTMLElement | null = null;
let chatSlotEl: HTMLElement | null = null;
let chatScrollEl: HTMLElement | null = null;
let lastSandboxRenderKey = '';
const seenMessageIds = new Set<string>();
const recipientFirstSeenAt = new Map<string, number>();
const RECIPIENT_ENTER_DURATION_MS = 420;
const RECIPIENT_ENTER_STAGGER_MS = 85;

/** 順番に出す発言。typingMs が 0 のものは書き込み中の表示をせず、少し間を置いて出す */
interface QueuedMessage {
  message: Omit<TimelineMessage, 'id'>;
  typingMs: number;
}

const QUEUE_PAUSE_MS = 650;
const messageQueue: QueuedMessage[] = [];
const queueTimers = new Set<number>();
let activeQueuedItem: QueuedMessage | null = null;
let isQueueRunning = false;
let queueRunId = 0;

function clearQueueTimers(): void {
  for (const id of queueTimers) {
    window.clearTimeout(id);
  }
  queueTimers.clear();
}

function sleepWithQueueTimer(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const id = window.setTimeout(() => {
      queueTimers.delete(id);
      resolve();
    }, ms);
    queueTimers.add(id);
  });
}

/** 発言の長さに応じた書き込み時間（音声OFF時のテンポ） */
function typingDurationFor(text: string): number {
  return Math.min(2000, 850 + text.length * 38);
}

function enqueueMessages(items: QueuedMessage[]): void {
  // キューに入った時点で裏で音声データを先読みし、吹き出しが出た瞬間に遅延ゼロで再生できるようにする
  if (state.voiceEnabled) {
    for (const item of items) {
      if (isSpokenMessage(item.message)) {
        void fetchTtsAudio(item.message.text, speakerOfMessage(item.message));
      }
    }
  }
  messageQueue.push(...items);
  if (!isQueueRunning) {
    isQueueRunning = true;
    void runQueueLoop(++queueRunId);
  }
}

async function runQueueLoop(runId: number): Promise<void> {
  while (runId === queueRunId && messageQueue.length > 0) {
    const next = messageQueue.shift()!;
    activeQueuedItem = next;
    const spoken = isSpokenMessage(next.message);

    if (next.typingMs > 0) {
      state.typingMessage = { role: next.message.role, personaId: next.message.personaId };
      renderStudio();
      scrollToLatestMessage();

      if (state.voiceEnabled && spoken) {
        // 音声ONのときは、最小限の「…」表示（550ms）と音声先読み完了（最大1800ms）が揃い次第すぐ吹き出しを出す
        const speaker = speakerOfMessage(next.message);
        await Promise.all([
          sleepWithQueueTimer(550),
          Promise.race([fetchTtsAudio(next.message.text, speaker), sleepWithQueueTimer(1800)]),
        ]);
      } else {
        await sleepWithQueueTimer(next.typingMs);
      }
    } else {
      state.typingMessage = undefined;
      renderStudio();
      await sleepWithQueueTimer(260);
    }

    if (runId !== queueRunId) return;

    activeQueuedItem = null;
    state.typingMessage = undefined;
    const shouldSpeak = state.voiceEnabled && spoken;
    const full = pushMessage(next.message, { skipAutoTts: true });
    renderStudio();
    scrollToLatestMessage();

    if (shouldSpeak) {
      // 現在の吹き出しの音声読み上げが終わるのを待ってから、次の発言の書き込みに進む
      await playTtsAndWait(full);
      if (runId !== queueRunId) return;
      if (messageQueue.length > 0) {
        await sleepWithQueueTimer(220);
      }
    } else if (messageQueue.length > 0) {
      await sleepWithQueueTimer(QUEUE_PAUSE_MS);
    }
  }

  if (runId === queueRunId) {
    activeQueuedItem = null;
    clearQueueTimers();
    state.typingMessage = undefined;
    isQueueRunning = false;
    renderStudio();
  }
}

/** チャット欄をタップしたときは、いま待っている発言を1つだけ即座に出してその音声へ切り替える */
function advanceOneQueuedMessage(): void {
  const item = activeQueuedItem ?? messageQueue.shift() ?? null;
  activeQueuedItem = null;
  clearQueueTimers();
  stopAllTtsPlayback();
  state.typingMessage = undefined;
  const myRunId = ++queueRunId;

  if (!item) {
    isQueueRunning = false;
    renderStudio();
    return;
  }

  const spoken = isSpokenMessage(item.message);
  const shouldSpeak = state.voiceEnabled && spoken;
  const full = pushMessage(item.message, { skipAutoTts: true });
  renderStudio();
  scrollToLatestMessage();

  isQueueRunning = true;
  void (async () => {
    if (shouldSpeak) {
      await playTtsAndWait(full);
      if (myRunId !== queueRunId) return;
      if (messageQueue.length > 0) {
        await sleepWithQueueTimer(220);
      }
    } else if (messageQueue.length > 0) {
      await sleepWithQueueTimer(QUEUE_PAUSE_MS);
    }
    if (myRunId !== queueRunId) return;
    await runQueueLoop(myRunId);
  })();
}

/** 学習者が先に操作したときは、残りの発言を待たずにすべて出して順序を保つ */
function flushMessageQueue(): void {
  ++queueRunId;
  isQueueRunning = false;
  clearQueueTimers();
  stopAllTtsPlayback();
  state.typingMessage = undefined;
  if (activeQueuedItem) {
    const current = activeQueuedItem;
    activeQueuedItem = null;
    pushMessage(current.message, { skipAutoTts: true });
  }
  while (messageQueue.length > 0) {
    pushMessage(messageQueue.shift()!.message, { skipAutoTts: true });
  }
}

/** 一時的な返信候補・反応確認ボタンのシステムメッセージを履歴から整理する */
function clearTransientChoiceMessages(): void {
  state.messages = state.messages.filter(
    (m) =>
      !(
        m.role === 'system' &&
        ((m.followUps && m.followUps.length > 0) || m.showEvaluateAction)
      ),
  );
}

/** 冒頭の会話。店長とお助けエージェントの行は書き込み中の表示を挟んで話す */
function playInitialWelcomeSequence(): void {
  // 開いた瞬間にチャットが空だと何が始まるか分からないので、最初の場面の説明だけはすぐ出す
  const [first, ...rest] = ACTIVE_THEME.introScript;
  const lines = first?.speaker === 'system' && !first.showCohortSelector ? rest : ACTIVE_THEME.introScript;
  if (lines !== ACTIVE_THEME.introScript) {
    pushMessage({ role: 'system', text: first.text });
  }
  enqueueMessages(
    lines.map((line) => ({
      message: {
        role: line.speaker,
        text: line.text,
        showCohortSelector: line.showCohortSelector,
      },
      typingMs:
        line.speaker === 'owner' || line.speaker === 'assistant'
          ? typingDurationFor(line.text)
          : 0,
    })),
  );
}

function scrollToLatestMessage(): void {
  window.requestAnimationFrame(() => {
    if (chatScrollEl) {
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
    }
  });
}

/**
 * スマホの中で起きたこと（押しても反応がない等）を、画面を邪魔しないよう進行役の発言としてチャットに出す。
 * ボタンを連打しても埋まらないよう、直前と同じ内容なら重ねて出さない。
 */
function postSandboxNotice(message: string, type: 'info' | 'success' | 'warning'): void {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'system' && last.text === message) return;
  pushMessage({ role: 'system', tone: type === 'warning' ? 'warning' : 'default', text: message });
  renderStudio();
  scrollToLatestMessage();
}

/**
 * 部品が画面に見えているか。画面下に固定したバーの裏やスクロールの外に隠れている部品は、
 * 赤ペンの線がかかっても選ばないようにする。
 * ポップアップの半透明の背景幕（.inapp-popup-backdrop）は透けて裏の部品が見えるため無視し、
 * ポップアップ本体（.inapp-popup-card）や固定バーの裏に完全に隠れている部品だけを除外する。
 */
function isPartlyVisible(el: HTMLElement, r: DOMRect): boolean {
  const doc = el.ownerDocument;
  const points: Array<[number, number]> = [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
  ];
  return points.some(([fx, fy]) => {
    const x = r.left + r.width * fx;
    const y = r.top + r.height * fy;
    const stack = doc.elementsFromPoint
      ? doc.elementsFromPoint(x, y)
      : [doc.elementFromPoint(x, y)].filter((n): n is Element => n !== null);
    const hit = stack.find((node) => !node.classList.contains('inapp-popup-backdrop'));
    return !!hit && (hit === el || el.contains(hit));
  });
}

function collectComponentRects(container: HTMLElement): Rect2D[] {
  const containerRect = container.getBoundingClientRect();
  const elements = querySandboxComponentElements(container);
  const rects: Rect2D[] = [];
  for (const el of elements) {
    const id = el.dataset.componentId;
    if (!id) continue;
    const r = el.getBoundingClientRect();
    if (!isPartlyVisible(el, r)) continue;
    const isInsideIframe = el.ownerDocument !== document;
    rects.push({
      id,
      left: isInsideIframe ? r.left : r.left - containerRect.left,
      top: isInsideIframe ? r.top : r.top - containerRect.top,
      right: isInsideIframe ? r.right : r.right - containerRect.left,
      bottom: isInsideIframe ? r.bottom : r.bottom - containerRect.top,
    });
  }
  return rects;
}

function redrawPenCanvas(): void {
  if (!penCanvasEl || !sandboxStageEl) return;
  const rect = sandboxStageEl.getBoundingClientRect();
  if (
    penCanvasEl.width !== Math.round(rect.width) ||
    penCanvasEl.height !== Math.round(rect.height)
  ) {
    penCanvasEl.width = Math.max(1, Math.round(rect.width));
    penCanvasEl.height = Math.max(1, Math.round(rect.height));
  }
  const ctx = penCanvasEl.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, penCanvasEl.width, penCanvasEl.height);

  if (state.penPoints.length < 2) return;

  ctx.save();
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(state.penPoints[0].x, state.penPoints[0].y);
  for (let i = 1; i < state.penPoints.length; i++) {
    ctx.lineTo(state.penPoints[i].x, state.penPoints[i].y);
  }
  ctx.stroke();
  ctx.restore();
}

function attachPenEvents(canvas: HTMLCanvasElement, stage: HTMLElement): void {
  let drawing = false;

  const getLocalPoint = (e: PointerEvent): Point2D => {
    const r = stage.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (state.interactionMode !== 'pen') return;
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    state.penPoints = [getLocalPoint(e)];
    redrawPenCanvas();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    state.penPoints.push(getLocalPoint(e));
    redrawPenCanvas();
  });

  const finishStroke = () => {
    if (!drawing) return;
    drawing = false;
    const rects = collectComponentRects(stage);
    const hits = detectHitComponents(state.penPoints, rects);
    state.circledComponentIds = hits;
    renderStudio();
    // 囲めたら、お助けエージェントがその部品を受け止めて、どうしたいかを尋ねる
    if (hits.length > 0) void reactToCircle(hits);
  };

  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);

  // 赤ペンのときも画面をスクロールできるようにする。描いた線は画面と一緒に動かないので消し、
  // 囲んだ部品の印（画面側の赤枠）は残す
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (state.interactionMode !== 'pen' || drawing) return;
      e.preventDefault();
      if (!sandboxAppMountEl) return;
      const scrolled = scrollSandboxBy(sandboxAppMountEl, e.deltaY);
      if (scrolled && state.penPoints.length > 0) {
        state.penPoints = [];
        redrawPenCanvas();
      }
    },
    { passive: false },
  );
}

/**
 * 改造後の画面に状態を移す際、初期値が変わっていない状態キーについては
 * 学習者がすでに選んだ値（支払い方法・閉じた広告など）を引き継ぐ。
 */
function preserveUnchangedLiveState(
  prevSpec: AppSpec,
  nextSpec: AppSpec,
  prevLiveState: Record<string, StateValue>,
): Record<string, StateValue> {
  const base = createInitialState(nextSpec);
  for (const s of nextSpec.state) {
    const prevDef = prevSpec.state.find((p) => p.key === s.key);
    if (
      prevDef &&
      prevDef.initialValue === s.initialValue &&
      prevLiveState[s.key] !== undefined
    ) {
      base[s.key] = prevLiveState[s.key];
    }
  }
  return withDerivedValues(nextSpec, base);
}

function pushNewCheckpoint(commitMessage: string, updatedSpec: AppSpec): void {
  const prevSpec = getCurrentSpec();
  // 過去の画面に戻った状態で新しく手直ししたときは、その画面から分岐して以降の履歴を置き換える
  if (state.activeCheckpointIndex < state.checkpoints.length - 1) {
    state.checkpoints = state.checkpoints.slice(0, state.activeCheckpointIndex + 1);
  }
  const nextStepNumber = state.checkpoints.length;
  const newCheckpoint: Checkpoint = {
    id: `cp-${nextStepNumber}-${Date.now()}`,
    stepNumber: nextStepNumber,
    commitMessage,
    createdAt: new Date().toISOString(),
    spec: updatedSpec,
  };

  state.checkpoints.push(newCheckpoint);
  state.activeCheckpointIndex = state.checkpoints.length - 1;
  state.liveAppState = preserveUnchangedLiveState(prevSpec, updatedSpec, state.liveAppState);
  state.penPoints = [];
  state.circledComponentIds = [];
  state.topicTargetIds = [];
  state.interactionMode = 'play';
}

async function recordDecision(body: RecordDecisionRequest): Promise<void> {
  try {
    const data = await postJson<RecordDecisionResponse>('/api/decision', body);
    state.decisions.push(data.decision);
  } catch (err) {
    // 記録に失敗しても体験の進行は止めない
    console.warn('[studio] 判断の記録に失敗しました:', err);
  }
}

function handleSelectCohort(cohortId: TargetCohortId): void {
  if (state.selectedCohortId) return;
  flushMessageQueue();
  clearTransientChoiceMessages();
  const selector = [...state.messages].reverse().find((m) => m.showCohortSelector);
  if (selector) selector.chosenCohortId = cohortId;
  startCohort(cohortId);
}

/**
 * クリア後に、画面を最初に戻してやり直す。
 * 1回の挑戦は1つの客層だけなので、直した画面を引き継いで別の客層を呼ぶことはしない。
 * sameCohortId を渡すと同じ客層でそのまま始め、渡さなければ客層を選び直す
 */
function handleRestartFromScratch(sameCohortId?: TargetCohortId): void {
  flushMessageQueue();
  clearTransientChoiceMessages();
  state.runFinished = false;
  state.selectedCohortId = undefined;
  state.recipient = 'assistant';
  recipientFirstSeenAt.clear();
  state.checkpoints = [
    {
      id: `cp-0-${Date.now()}`,
      stepNumber: 0,
      commitMessage: 'かいぞう前',
      createdAt: new Date().toISOString(),
      spec: structuredClone(INITIAL_SPEC),
    },
  ];
  state.activeCheckpointIndex = 0;
  state.liveAppState = createInitialState(INITIAL_SPEC);
  state.penPoints = [];
  state.circledComponentIds = [];
  state.topicTargetIds = [];
  pushMessage({ role: 'system', text: '画面を最初の状態に戻しました' });
  if (sameCohortId) {
    startCohort(sameCohortId);
    return;
  }
  const selectorLine = ACTIVE_THEME.introScript.find((l) => l.showCohortSelector);
  pushMessage({
    role: 'system',
    text: selectorLine?.text ?? '誰のために直しますか',
    showCohortSelector: true,
  });
  renderStudio();
  scrollToLatestMessage();
}

function startCohort(cohortId: TargetCohortId): void {
  const cohort = TARGET_COHORTS.find((c) => c.id === cohortId) ?? TARGET_COHORTS[0];
  state.selectedCohortId = cohort.id;
  state.runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.recipient = 'assistant';
  recipientFirstSeenAt.clear();

  void recordDecision({
    stage: 'select_cohort',
    targetId: cohort.id,
    chosenLabel: cohort.label,
    reason: '',
    cohortId: cohort.id,
  });

  const currentSpec = getCurrentSpec();
  const reviewers = getReviewersByCohort(cohort.id);
  const hearingQueue: QueuedMessage[] = [
    {
      message: {
        role: 'system',
        text: `${cohort.label}の3人に、今の画面で困ったことをヒアリングしました`,
      },
      typingMs: 0,
    },
  ];

  let abandonedCount = 0;
  const unhappyNames: string[] = [];
  for (const persona of reviewers) {
    const sim = simulatePersonaComputerUse(currentSpec, persona);
    hearingQueue.push({
      message: { role: 'customer', personaId: persona.id, text: persona.greeting },
      typingMs: typingDurationFor(persona.greeting),
    });
    if (sim.outcome !== 'achieved') {
      abandonedCount++;
      unhappyNames.push(persona.name);
      hearingQueue.push({
        message: { role: 'customer', personaId: persona.id, text: sim.simulatedComment },
        typingMs: typingDurationFor(sim.simulatedComment),
      });
    }
  }

  const guideLines =
    abandonedCount > 0
      ? [
          abandonedCount === reviewers.length
            ? '3人とも満足して買えずに帰ってしまっていますね…'
            : `${unhappyNames.map((n) => (n.startsWith('客') ? n : `${n}さん`)).join('と')}が、満足して買えずに帰ってしまっていますね…`,
          '左のスマホを実際に触って確かめながら、直したい場所を赤ペンで囲んで指示してください！',
        ]
      : [
          'この3人が満足して買える画面に直しましょう！',
          '左のスマホを触って、直したい場所を赤ペンで囲んで指示してくださいね',
        ];

  for (const line of guideLines) {
    hearingQueue.push({
      message: { role: 'assistant', text: line },
      typingMs: typingDurationFor(line),
    });
  }

  enqueueMessages(hearingQueue);
}

/** AIに渡す直近の会話。スマホ画面の反応なし通知も含めて文脈が伝わるようにする */
/** 店長が同じ言い回しを繰り返さないよう、これまでの店長のせりふだけを渡す（会話の古い部分も含める） */
function buildOwnerHistory(): ChatHistoryEntry[] {
  return state.messages
    .filter((m) => m.role === 'owner')
    .slice(-10)
    .map((m) => ({ speaker: OWNER.name, text: m.text }));
}

function buildChatHistory(): ChatHistoryEntry[] {
  return state.messages
    .filter(
      (m) =>
        m.text.trim().length > 0 &&
        !(
          m.role === 'system' &&
          ((m.followUps && m.followUps.length > 0) || m.showEvaluateAction)
        ),
    )
    .slice(-12)
    .map((m) => ({
      speaker:
        m.role === 'user'
          ? 'ユーザー'
          : m.role === 'assistant'
            ? 'お助けAI'
            : m.role === 'owner'
              ? OWNER.name
              : m.role === 'system'
                ? 'スマホ画面の通知'
                : `お客さんの${findPersona(m.personaId)?.name ?? ''}`,
      text: m.text,
    }));
}

/**
 * 発言を送る。送信と同時にスマホ画面の囲みは消すが、囲んだ部品は話題として次の発言にも引き継ぐ。
 * 改造の指示であれば改造案カードを出さずに直接パッチを適用し、店長が変更にリアクションする。
 */
/** 赤ペンで囲んだ部品について、お助けエージェントが受け止めて尋ねる。画面は変えず、囲みも残す */
let circleRequestSeq = 0;
let circleInFlight = false;

async function reactToCircle(targetIds: string[]): Promise<void> {
  // 誰のために直すかを選ぶ前や、改造中・質問への回答待ちのときは割り込まない
  if (!state.selectedCohortId) return;
  if (state.chatLoading && !circleInFlight) return;
  const seq = ++circleRequestSeq;
  circleInFlight = true;
  flushMessageQueue();
  // 前に囲んだときの反応がチャットの最後に残っていれば、置き換える
  while (state.messages.length > 0 && state.messages[state.messages.length - 1].circleReaction) {
    state.messages.pop();
  }
  clearTransientChoiceMessages();
  state.topicTargetIds = [...targetIds];
  state.chatLoading = true;
  renderStudio();
  scrollToLatestMessage();
  try {
    const spec = getCurrentSpec();
    const annotatedImageBase64 = sandboxStageEl
      ? captureSandboxSnapshot(spec, state.liveAppState, sandboxStageEl, penCanvasEl)
      : undefined;
    const data = await postJson<ChatResponse>('/api/chat', {
      currentSpec: spec,
      latestReviews: buildLatestReviewRecord(),
      targetComponentIds: targetIds,
      userMessage: '',
      cohortId: state.selectedCohortId,
      runId: state.runId,
      annotatedImageBase64,
      history: buildChatHistory(),
      mode: 'circled',
    });
    if (seq !== circleRequestSeq) return;
    const chunks = splitIntoChatChunks(data.reply);
    for (const chunk of chunks) {
      pushMessage({
        role: 'assistant',
        text: chunk,
        targetComponentIds: targetIds,
        circleReaction: true,
      });
    }
    if (data.suggestedFollowUps && data.suggestedFollowUps.length > 0) {
      pushMessage({
        role: 'system',
        text: 'どう手直ししますか',
        targetComponentIds: targetIds,
        circleReaction: true,
        followUps: data.suggestedFollowUps,
      });
    }
  } catch (err) {
    if (seq === circleRequestSeq) {
      pushMessage({ role: 'system', tone: 'warning', text: describeError(err) });
    }
  } finally {
    if (seq === circleRequestSeq) {
      circleInFlight = false;
      state.chatLoading = false;
      renderStudio();
      scrollToLatestMessage();
      sendPendingIfReady();
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const WORK_STEP_INTERVAL_MS = 450;

/** 準備中の進捗文言を更新する */
function setPrepWorkStep(log: NonNullable<TimelineMessage['workLog']>, text: string): void {
  log.steps = [{ text, done: false }];
  renderStudio();
  scrollToLatestMessage();
}

/** 作業ログの行を足す。前の行は終わったことにする */
function addWorkStep(
  log: NonNullable<TimelineMessage['workLog']>,
  text: string,
  done = false,
  componentId?: string,
): void {
  for (const step of log.steps) step.done = true;
  log.steps.push({ text, done, componentId });
  renderStudio();
  scrollToLatestMessage();
}

function startWorkLog(targetIds: string[]): TimelineMessage {
  return pushMessage({
    role: 'system',
    text: '',
    targetComponentIds: targetIds,
    workLog: { steps: [{ text: '指示を読んでいます', done: false }], finished: false },
  });
}

let highlightClearTimer: number | null = null;

/** システムメッセージの作業行をクリックしたとき、スマホ内の該当部品へスクロールして光らせる */
function highlightSandboxComponent(componentId: string): void {
  if (highlightClearTimer !== null) {
    window.clearTimeout(highlightClearTimer);
    highlightClearTimer = null;
  }
  state.justChangedIds = [componentId];
  renderStudio();
  if (sandboxStageEl) {
    const el = querySandboxComponentElements(sandboxStageEl).find(
      (node) => node.dataset.componentId === componentId,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  highlightClearTimer = window.setTimeout(() => {
    highlightClearTimer = null;
    if (state.justChangedIds.length === 1 && state.justChangedIds[0] === componentId) {
      state.justChangedIds = [];
      renderStudio();
    }
  }, 1800);
}

/**
 * 改造の結果を、システムのメッセージとして1行ずつ見せ、完了後もそのまま残す。
 * 行ごとにスマホのその部品を光らせる。
 */
async function playWorkLog(
  logMessage: TimelineMessage,
  steps: Array<{ text: string; componentId?: string }>,
  rolledBack: boolean,
): Promise<void> {
  const log = logMessage.workLog!;
  if (rolledBack) {
    log.steps = [{ text: '画面がうまく表示できなかったので、元に戻しました', done: true }];
    logMessage.text = log.steps[0].text;
    renderStudio();
    scrollToLatestMessage();
  } else {
    // 準備中の行は消して、実際に行った作業の行だけをシステムメッセージとして残す
    log.steps = [];
    for (const step of steps) {
      state.justChangedIds = step.componentId ? [step.componentId] : [];
      addWorkStep(log, step.text, false, step.componentId);
      if (step.componentId && sandboxStageEl) {
        const el = querySandboxComponentElements(sandboxStageEl).find(
          (node) => node.dataset.componentId === step.componentId,
        );
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      await sleep(WORK_STEP_INTERVAL_MS);
      log.steps[log.steps.length - 1].done = true;
    }
    state.justChangedIds = [];
    if (log.steps.length === 0) {
      addWorkStep(log, '画面を書き換えました', true);
    }
    logMessage.text = log.steps.map((s) => s.text).join(' / ');
  }
  log.finished = true;
  renderStudio();
}

/** 考え中に送ろうとした文を、返事が届いたあとに送る */
function sendPendingIfReady(): void {
  if (!state.pendingSend || state.chatLoading) return;
  state.pendingSend = false;
  if (state.inputText.trim()) void handleSendMessage();
  else renderStudio();
}

/** 発言内で別の相手を明確にメンションしているときだけ、切り替え先の宛先キーを返す */
function resolveExplicitRecipientSwitch(text: string): string | null {
  return detectExplicitRecipientMention(text);
}

let activeMediaRecorder: MediaRecorder | null = null;
let recordedAudioChunks: Blob[] = [];

function pickSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

async function toggleVoiceRecording(): Promise<void> {
  if (state.isRecordingAudio && activeMediaRecorder) {
    activeMediaRecorder.stop();
    return;
  }
  if (!state.selectedCohortId || state.chatLoading || state.isTranscribingAudio) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedAudioChunks = [];
    const mimeType = pickSupportedAudioMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    activeMediaRecorder = recorder;
    state.isRecordingAudio = true;
    renderStudio();

    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) recordedAudioChunks.push(e.data);
    });
    recorder.addEventListener('stop', () => {
      for (const track of stream.getTracks()) track.stop();
      state.isRecordingAudio = false;
      activeMediaRecorder = null;
      const resolvedMime = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(recordedAudioChunks, { type: resolvedMime });
      recordedAudioChunks = [];
      if (blob.size < 100) {
        renderStudio();
        return;
      }
      const reader = new FileReader();
      reader.onloadend = async () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) {
          renderStudio();
          return;
        }
        state.isTranscribingAudio = true;
        renderStudio();
        try {
          const spec = getCurrentSpec();
          const hasPenAnnotation =
            state.circledComponentIds.length > 0 || state.penPoints.length > 0;
          const targetComponentIds = hasPenAnnotation
            ? [...state.circledComponentIds]
            : [...state.topicTargetIds];
          const annotatedImageBase64 =
            hasPenAnnotation && sandboxStageEl
              ? captureSandboxSnapshot(spec, state.liveAppState, sandboxStageEl, penCanvasEl)
              : undefined;
          const res = await postJson<TranscribeResponse>('/api/transcribe', {
            audioBase64: dataUrl,
            audioMimeType: resolvedMime,
            currentSpec: spec,
            targetComponentIds,
            annotatedImageBase64,
          });
          if (res.hasMeaningfulSpeech && res.cleanedText.trim()) {
            const cleaned = res.cleanedText.trim();
            state.inputText = state.inputText.trim()
              ? `${state.inputText.trim()} ${cleaned}`
              : cleaned;
            const switched = resolveExplicitRecipientSwitch(state.inputText);
            if (switched) state.recipient = switched;
          } else {
            pushMessage({
              role: 'system',
              text: '音声が聞き取れなかったか、手直しに関係する言葉が見つかりませんでした',
            });
          }
        } catch (err) {
          pushMessage({ role: 'system', tone: 'warning', text: describeError(err) });
        } finally {
          state.isTranscribingAudio = false;
          renderStudio();
          window.requestAnimationFrame(() => {
            const inputEl = shellEl?.querySelector<HTMLInputElement>('.composer-input');
            if (inputEl) {
              inputEl.focus();
              const len = inputEl.value.length;
              inputEl.setSelectionRange(len, len);
            }
          });
        }
      };
      reader.readAsDataURL(blob);
    });
    recorder.start();
  } catch {
    state.isRecordingAudio = false;
    pushMessage({
      role: 'system',
      tone: 'warning',
      text: 'マイクの使用が許可されていないか、音声入力に対応していません',
    });
    renderStudio();
  }
}

async function handleSendMessage(
  overrideText?: string,
  targetIdsOverride?: string[],
): Promise<void> {
  if (!state.selectedCohortId) return;
  const text = (overrideText ?? state.inputText).trim();
  if (!text) return;
  if (state.chatLoading) {
    // 入力欄から送ろうとしたときは、取りこぼさずに返事のあとで送る
    if (overrideText === undefined) {
      state.pendingSend = true;
      renderStudio();
    }
    return;
  }
  flushMessageQueue();
  clearTransientChoiceMessages();

  if (overrideText === undefined) {
    const switched = resolveExplicitRecipientSwitch(text);
    if (switched) state.recipient = switched;
  }

  const spec = getCurrentSpec();
  const recipientSnapshot = overrideText !== undefined ? 'assistant' : state.recipient;
  // 挑戦が終わったあとは、店長やお客さんへの質問だけを受け付ける
  if (state.runFinished && recipientSnapshot === 'assistant') {
    pushMessage({
      role: 'system',
      tone: 'warning',
      text: 'この挑戦は終わりました。上の選択肢からやり直すと、また手直しできます。店長やお客さんには質問できます',
    });
    renderStudio();
    scrollToLatestMessage();
    return;
  }
  const hasPenAnnotation = state.circledComponentIds.length > 0 || state.penPoints.length > 0;
  const targetIdsSnapshot = hasPenAnnotation
    ? [...state.circledComponentIds]
    : [...(targetIdsOverride ?? state.topicTargetIds)];
  state.topicTargetIds = targetIdsSnapshot;
  const history = buildChatHistory();
  // 囲みを消す前に、赤ペン付きの画面を撮っておく
  const annotatedImageBase64 =
    hasPenAnnotation && sandboxStageEl
      ? captureSandboxSnapshot(spec, state.liveAppState, sandboxStageEl, penCanvasEl)
      : undefined;

  pushMessage({
    role: 'user',
    text,
    targetComponentIds: targetIdsSnapshot,
  });
  if (overrideText === undefined) {
    state.inputText = '';
  }
  state.penPoints = [];
  state.circledComponentIds = [];

  // チャットから「1つ前に戻して」「最初の画面に戻して」と指示されたときは、会話の流れを保ったまま即座に画面を戻す
  const revertCommand =
    recipientSnapshot === 'assistant' && !hasPenAnnotation
      ? detectCheckpointRevertCommand(text)
      : null;
  if (revertCommand) {
    if (state.checkpoints.length <= 1) {
      pushMessage({
        role: 'assistant',
        text: 'いまは一番最初の画面なので、これ以上前の画面はありません。気になるところを赤ペンで囲むか、直したい場所を教えてくださいね。',
      });
    } else if (revertCommand === 'reset') {
      const prevSpec = getCurrentSpec();
      state.checkpoints = [state.checkpoints[0]];
      state.activeCheckpointIndex = 0;
      state.liveAppState = preserveUnchangedLiveState(
        prevSpec,
        getCurrentSpec(),
        state.liveAppState,
      );
      state.topicTargetIds = [];
      pushMessage({ role: 'system', text: '一番最初の画面に戻しました' });
      pushMessage({
        role: 'assistant',
        text: '一番最初の画面に戻しました。どこから手直ししますか？',
      });
    } else {
      const prevSpec = getCurrentSpec();
      state.checkpoints.pop();
      state.activeCheckpointIndex = state.checkpoints.length - 1;
      state.liveAppState = preserveUnchangedLiveState(
        prevSpec,
        getCurrentSpec(),
        state.liveAppState,
      );
      state.topicTargetIds = [];
      pushMessage({ role: 'system', text: '1つ前の画面に戻しました' });
      pushMessage({
        role: 'assistant',
        text: '1つ前の画面に戻しました。ここからどう手直ししますか？',
      });
    }
    renderStudio();
    scrollToLatestMessage();
    return;
  }

  state.chatLoading = true;
  // はっきりした改造の指示（かつ店長やお客さん宛てでないとき）なら、返事を待つ間から作業の過程をシステムメッセージで見せる
  const canApplyDirectly = recipientSnapshot === 'assistant';
  let logMessage: TimelineMessage | undefined =
    canApplyDirectly && text && classifyUserMessageIntent(text) === 'apply'
      ? startWorkLog(targetIdsSnapshot)
      : undefined;
  const logTimers: number[] = [];
  if (logMessage) {
    const log = logMessage.workLog!;
    logTimers.push(
      window.setTimeout(() => !log.finished && setPrepWorkStep(log, '画面の部品を調べています'), 900),
      window.setTimeout(() => !log.finished && setPrepWorkStep(log, '変え方を考えています'), 2200),
    );
  }
  renderStudio();
  scrollToLatestMessage();

  try {
    const data = await postJson<ChatResponse>('/api/chat', {
      currentSpec: spec,
      latestReviews: buildLatestReviewRecord(),
      targetComponentIds: targetIdsSnapshot,
      userMessage: text,
      cohortId: state.selectedCohortId,
      runId: state.runId,
      annotatedImageBase64,
      history,
      recipient: recipientSnapshot,
    });

    logTimers.forEach((t) => window.clearTimeout(t));
    if (data.applied) {
      const applied = data.applied;
      if (applied.decisionRecord) {
        state.decisions.push(applied.decisionRecord);
      }
      // お助けエージェントが判断して改造に進んだときは、ここで作業ログを出す
      logMessage ??= startWorkLog(targetIdsSnapshot);
      if (!applied.rolledBack) {
        // 新しい画面にしてから作業を1行ずつ流し、変えた部品を光らせる
        pushNewCheckpoint(applied.commitMessage, applied.updatedSpec);
      }
      await playWorkLog(logMessage, applied.workSteps ?? [], Boolean(applied.rolledBack));
      if (applied.rolledBack) {
        pushMessage({
          role: 'assistant',
          text: applied.commitMessage,
          targetComponentIds: targetIdsSnapshot,
        });
      } else {
        const hasWorkingOrder = applied.updatedSpec.components.some(
          (c) => c.type === 'button' && hasCompletionAction(c),
        );
        pushMessage({
          role: 'assistant',
          text: applied.commitMessage,
          targetComponentIds: targetIdsSnapshot,
        });
        const evalChoiceMsg: Omit<TimelineMessage, 'id'> | undefined = hasWorkingOrder
          ? {
              role: 'system',
              text: '手直しした画面をお客さんに試してもらいますか',
              targetComponentIds: targetIdsSnapshot,
              showEvaluateAction: true,
            }
          : undefined;

        if (applied.ownerFacts && applied.ownerFacts.length > 0) {
          state.chatLoading = false;
          void speakOwner(
            {
              situation: 'change',
              facts: applied.ownerFacts,
              fallback: applied.ownerReaction ?? '',
            },
            evalChoiceMsg,
          );
          return;
        }
        if (evalChoiceMsg) {
          pushMessage(evalChoiceMsg);
        }
      }
    } else if (data.intent === 'owner') {
      // 店長に話しかけたときは、店長本人が返事をする
      if (logMessage) state.messages = state.messages.filter((m) => m !== logMessage);
      state.chatLoading = false;
      enqueueMessages(
        splitIntoChatChunks(data.reply).map((chunk, i) => ({
          message: { role: 'owner' as const, text: chunk },
          typingMs: i === 0 ? 400 : typingDurationFor(chunk),
        })),
      );
      return;
    } else if (data.intent === 'customer') {
      // お客さんに話しかけたときは、選んだ客層の3人が順番に一言ずつ返事をする
      if (logMessage) state.messages = state.messages.filter((m) => m !== logMessage);
      state.chatLoading = false;
      const replies =
        data.customerReplies && data.customerReplies.length > 0
          ? data.customerReplies
          : [{ personaId: data.customerPersonaId ?? '', text: data.reply }];
      const queued: QueuedMessage[] = [];
      replies.forEach((item, idx) => {
        for (const [chunkIdx, chunk] of splitIntoChatChunks(item.text).entries()) {
          queued.push({
            message: { role: 'customer' as const, personaId: item.personaId, text: chunk },
            typingMs: idx === 0 && chunkIdx === 0 ? 400 : typingDurationFor(chunk),
          });
        }
      });
      enqueueMessages(queued);
      return;
    } else {
      // 改造だと思って作業ログを出したが、質問や聞き返しだったときは消す
      if (logMessage) state.messages = state.messages.filter((m) => m !== logMessage);
      const replyChunks = splitIntoChatChunks(data.reply);
      const [firstChunk, ...restChunks] = replyChunks;
      pushMessage({
        role: 'assistant',
        text: firstChunk,
        targetComponentIds: targetIdsSnapshot,
      });
      const followUpMsg: Omit<TimelineMessage, 'id'> | undefined =
        data.suggestedFollowUps && data.suggestedFollowUps.length > 0
          ? {
              role: 'system',
              text: 'どう手直ししますか',
              targetComponentIds: targetIdsSnapshot,
              followUps: data.suggestedFollowUps,
            }
          : undefined;
      if (restChunks.length > 0) {
        state.chatLoading = false;
        const queued: QueuedMessage[] = restChunks.map((chunk) => ({
          message: {
            role: 'assistant' as const,
            text: chunk,
            targetComponentIds: targetIdsSnapshot,
          },
          typingMs: typingDurationFor(chunk),
        }));
        if (followUpMsg) {
          queued.push({ message: followUpMsg, typingMs: 0 });
        }
        enqueueMessages(queued);
        return;
      }
      if (followUpMsg) {
        pushMessage(followUpMsg);
      }
    }
  } catch (err) {
    logTimers.forEach((t) => window.clearTimeout(t));
    if (logMessage?.workLog && !logMessage.workLog.finished) {
      state.messages = state.messages.filter((m) => m !== logMessage);
    }
    pushMessage({ role: 'system', tone: 'warning', text: describeError(err) });
  } finally {
    state.justChangedIds = [];
    state.chatLoading = false;
    renderStudio();
    scrollToLatestMessage();
    sendPendingIfReady();
  }
}

/**
 * 店長に話してもらう。せりふはAIが作るので、届くまで店長の書き込み中の表示を出しておく。
 * 届かなかったときは決まったせりふを使う
 */
async function speakOwner(
  req: Omit<OwnerLineRequest, 'history'>,
  afterMessage?: Omit<TimelineMessage, 'id'>,
): Promise<void> {
  state.typingMessage = { role: 'owner' };
  renderStudio();
  scrollToLatestMessage();
  let text = req.fallback;
  try {
    const data = await postJson<OwnerLineResponse>('/api/owner-line', {
      ...req,
      history: buildOwnerHistory(),
    });
    text = data.text || req.fallback;
  } catch {
    // 決まったせりふを使う
  }
  if (state.typingMessage?.role === 'owner') state.typingMessage = undefined;
  const chunks = text ? splitIntoChatChunks(text) : [];
  const queued: QueuedMessage[] = chunks.map((chunk, i) => ({
    message: { role: 'owner' as const, text: chunk },
    typingMs: i === 0 ? 300 : typingDurationFor(chunk),
  }));
  if (afterMessage) {
    queued.push({ message: afterMessage, typingMs: 0 });
  }
  if (queued.length === 0) {
    renderStudio();
    return;
  }
  // 1つ目はすでに書き込み中を見せて待たせたので、すぐ出す
  enqueueMessages(queued);
}

async function handleEvaluate(): Promise<void> {
  if (state.evaluateLoading || !state.selectedCohortId) return;
  flushMessageQueue();
  clearTransientChoiceMessages();
  state.evaluateLoading = true;
  renderStudio();
  scrollToLatestMessage();

  try {
    const activePersonas = getReviewersByCohort(state.selectedCohortId);
    const currentSpec = getCurrentSpec();
    const componentBounds = sandboxStageEl ? collectComponentRects(sandboxStageEl) : undefined;
    const screenshotBase64 = sandboxStageEl
      ? captureSandboxSnapshot(currentSpec, state.liveAppState, sandboxStageEl, null)
      : undefined;

    const evaluation = await postJson<EvaluationResponse>('/api/evaluate', {
      currentSpec,
      cohortId: state.selectedCohortId,
      runId: state.runId,
      screenshotBase64,
      componentBounds,
      history: buildOwnerHistory(),
    });
    getCurrentCheckpoint().evaluation = evaluation;

    // お客さん3人の反応を書き込み中の表示を挟んで1人ずつ出す（店長は変更直後に反応済みのためここでは話さない）
    const queued: QueuedMessage[] = [];
    let achievedCount = 0;
    for (const persona of activePersonas) {
      const result = evaluation.results.find((r) => r.reviewerId === persona.id);
      if (!result) continue;
      if (result.outcome === 'achieved') achievedCount++;
      queued.push({
        message: {
          role: 'customer',
          personaId: persona.id,
          text: result.comment,
          review: { outcome: result.outcome },
        },
        typingMs: typingDurationFor(result.comment),
      });
    }
    // 選んだ3人のうち誰かが買えるようになったら、選ばなかった客層への影響も見せる。
    // 誰のために直したかで別の誰かが困ることに、その場で気づけるようにする
    const otherPersonas = ALL_REVIEWER_PERSONAS.filter(
      (p) => !activePersonas.some((a) => a.id === p.id),
    );
    // クリアしたときは、あとのレポートで1人ずつ詳しく出す
    if (achievedCount > 0 && achievedCount < activePersonas.length) {
      queued.push({
        message: {
          role: 'system',
          text: describeOtherCohortImpact(currentSpec, otherPersonas, componentBounds).line,
        },
        typingMs: 0,
      });
    }
    if (achievedCount === activePersonas.length) {
      queued.push({
        message: {
          role: 'system',
          text: '🎉 選んだお客さん3人全員が、気持ちよく注文できました！',
        },
        typingMs: 0,
      });
      for (const ownerLine of evaluation.owner?.closingLines ??
        buildOwnerClosingLines(OWNER, evaluation.owner)) {
        queued.push({
          message: { role: 'owner', text: ownerLine },
          typingMs: typingDurationFor(ownerLine),
        });
      }
      if (state.selectedCohortId && !state.clearedCohortIds.includes(state.selectedCohortId)) {
        state.clearedCohortIds.push(state.selectedCohortId);
      }
      // 1回の挑戦は、選んだ客層の3人が全員達成したところで終わる。やり直すまで手直しは受け付けない
      state.runFinished = true;
      const remaining = TARGET_COHORTS.filter((c) => !state.clearedCohortIds.includes(c.id));
      const closing =
        remaining.length > 0
          ? ['おつかれさまでした！今回の挑戦のレポートです']
          : ['おつかれさまでした！これで3つの客層すべてをクリアしました', '今回の挑戦のレポートです'];
      for (const line of closing) {
        queued.push({
          message: {
            role: 'assistant',
            text: line,
          },
          typingMs: typingDurationFor(line),
        });
      }
      for (const telemetryLine of evaluation.telemetrySummary?.systemLogLines ?? []) {
        queued.push({
          message: {
            role: 'system',
            text: telemetryLine,
          },
          typingMs: 0,
        });
      }
      const report = describeOtherCohortReport(currentSpec, otherPersonas, componentBounds);
      queued.push({
        message: {
          role: 'system',
          text: `ほかの客層のお客さんは、この画面をこう思いそうです 満足しそうなのは \`${report.total}人中${report.achieved}人\``,
        },
        typingMs: 0,
      });
      for (const line of report.lines) {
        queued.push({ message: { role: 'system', text: line }, typingMs: 0 });
      }
      queued.push({
        message: {
          role: 'system',
          text: '次はどうしますか どちらも画面を最初に戻してやり直します',
          showNextChallenge: true,
        },
        typingMs: 0,
      });
    } else {
      for (const line of [
        `3人中${achievedCount}人が満足して買えました`,
        '気になるお客さんに話を聞くか、直したい場所を指示してください',
      ]) {
        queued.push({
          message: { role: 'assistant', text: line },
          typingMs: typingDurationFor(line),
        });
      }
    }
    state.evaluateLoading = false;
    enqueueMessages(queued);
  } catch (err) {
    pushMessage({ role: 'system', tone: 'warning', text: describeError(err) });
  } finally {
    state.evaluateLoading = false;
    renderStudio();
    scrollToLatestMessage();
  }
}

function renderCohortSelector(msg: TimelineMessage, isLatestSelector: boolean): HTMLElement {
  const pillRow = document.createElement('div');
  pillRow.className = 'cohort-pill-row';
  for (const c of TARGET_COHORTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSelected = msg.chosenCohortId === c.id;
    btn.className = `cohort-pill-btn ${isSelected ? 'is-selected' : ''}`;
    // やり直したあとは、一番新しい選択肢だけを押せるようにする
    btn.disabled = state.selectedCohortId !== undefined || !isLatestSelector;
    btn.textContent = state.clearedCohortIds.includes(c.id) ? `${c.label} クリア済み` : c.label;
    btn.addEventListener('click', () => handleSelectCohort(c.id));
    pillRow.appendChild(btn);
  }
  return pillRow;
}

/** クリア後の「ほかのお客さんにもチャレンジしますか」の選択肢（システムメッセージ表示） */
function renderNextChallengeSelector(msg: TimelineMessage, isLatestChallenge: boolean): HTMLElement {
  const pillRow = document.createElement('div');
  pillRow.className = 'cohort-pill-row';
  const currentCohortId = state.selectedCohortId;
  const options: Array<{ key: string; label: string; onSelect: () => void }> = [
    {
      key: 'same',
      label: '同じ客層でやり直す',
      onSelect: () => handleRestartFromScratch(currentCohortId),
    },
    {
      key: 'other',
      label: '別の客層でやり直す',
      onSelect: () => handleRestartFromScratch(),
    },
  ];
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSelected = msg.chosenOption === opt.key;
    btn.className = `cohort-pill-btn ${isSelected ? 'is-selected' : ''}`;
    btn.disabled = Boolean(msg.chosenOption) || !isLatestChallenge;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      msg.chosenOption = opt.key;
      opt.onSelect();
    });
    pillRow.appendChild(btn);
  }
  return pillRow;
}

/** お助けAIが出す選択肢（返信候補・お客さんの反応確認）をシステムメッセージのピルボタンとして描画する */
function renderActionChoiceRow(msg: TimelineMessage): HTMLElement | null {
  const pillRow = document.createElement('div');
  pillRow.className = 'cohort-pill-row';
  if (msg.showEvaluateAction && !evaluationFor(getCurrentCheckpoint()) && state.selectedCohortId) {
    const evalBtn = document.createElement('button');
    evalBtn.type = 'button';
    evalBtn.className = 'cohort-pill-btn';
    evalBtn.textContent = 'お客さんの反応を見る';
    evalBtn.addEventListener('click', () => {
      void handleEvaluate();
    });
    pillRow.appendChild(evalBtn);

    const skipEvalBtn = document.createElement('button');
    skipEvalBtn.type = 'button';
    skipEvalBtn.className = 'cohort-pill-btn';
    skipEvalBtn.textContent = '続けて手直しする';
    skipEvalBtn.addEventListener('click', () => {
      clearTransientChoiceMessages();
      renderStudio();
      window.requestAnimationFrame(() => {
        shellEl?.querySelector<HTMLInputElement>('.composer-input')?.focus();
      });
    });
    pillRow.appendChild(skipEvalBtn);
  }
  const followUps = msg.followUps ?? [];
  for (const followUp of followUps) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cohort-pill-btn';
    btn.textContent = followUp;
    btn.addEventListener('click', () => {
      void handleSendMessage(followUp, msg.targetComponentIds);
    });
    pillRow.appendChild(btn);
  }
  if (
    followUps.length > 0 &&
    !followUps.some((f) => f.includes('何もしない') || f.includes('そのまま'))
  ) {
    const noopBtn = document.createElement('button');
    noopBtn.type = 'button';
    noopBtn.className = 'cohort-pill-btn';
    noopBtn.textContent = '何もしない';
    noopBtn.addEventListener('click', () => {
      if (msg.targetComponentIds && msg.targetComponentIds.length > 0) {
        void recordDecision({
          stage: 'apply_change',
          targetId: msg.targetComponentIds.join(','),
          chosenLabel: '何もしない',
          reason: '',
          cohortId: state.selectedCohortId,
        });
      }
      state.penPoints = [];
      state.circledComponentIds = [];
      state.topicTargetIds = [];
      clearTransientChoiceMessages();
      renderStudio();
    });
    pillRow.appendChild(noopBtn);
  }
  return pillRow.childNodes.length > 0 ? pillRow : null;
}

/**
 * システムメッセージ行のテキストを描画する。
 * バッククォート `...` で囲まれた固有名詞・変更前後の値はインラインコード要素（.chat-system-token）にする。
 */
function appendFormattedSystemText(container: HTMLElement, text: string): void {
  const parts = text.split(/`([^`]+)`/g);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.className = 'chat-system-token';
      code.textContent = part;
      container.appendChild(code);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  }
}

/** 改造の進捗・変更内容を、ボックスに入れず通常のシステムメッセージ行と同じ形式で描画する */
function appendWorkLogLines(row: HTMLElement, msg: TimelineMessage): void {
  const log = msg.workLog!;
  for (const step of log.steps) {
    const line = document.createElement('div');
    if (step.done) {
      const componentId = step.componentId;
      line.className = `chat-system-line${componentId ? ' is-interactive is-selectable' : ''}`;
      appendFormattedSystemText(line, step.text);
      if (componentId) {
        line.title = 'クリックするとスマホ画面の該当箇所を光らせます';
        line.addEventListener('click', (e) => {
          e.stopPropagation();
          highlightSandboxComponent(componentId);
        });
      }
    } else {
      line.className = 'chat-system-line is-progress';
      const dots = document.createElement('span');
      dots.className = 'typing-dots';
      dots.setAttribute('aria-hidden', 'true');
      dots.innerHTML = '<span></span><span></span><span></span>';
      const text = document.createElement('span');
      appendFormattedSystemText(text, step.text);
      line.append(dots, text);
    }
    row.appendChild(line);
  }
}

const AGENT_NAME = 'お助けAI';
const AGENT_ICON = '助';

function getRecipientPlaceholder(recipient: string): string {
  if (recipient === 'owner') {
    return `${OWNER.name}に話しかける（例：定期便のチェック外してもいい？）`;
  }
  if (recipient === 'customer') {
    return 'お客さんに聞く（例：どこで困ったの？ / 定期便はあった方がいい？）';
  }
  return 'お助けAIに手直しの指示や質問を入力（例：注文ボタンを動くように直して）';
}

function selectRecipientAndFocus(recipient: string): void {
  if (!state.selectedCohortId) return;
  state.recipient = recipient;
  renderStudio();
  window.requestAnimationFrame(() => {
    shellEl?.querySelector<HTMLInputElement>('.composer-input')?.focus();
  });
}

function createBubble(className: string, text: string): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = className;
  const body = document.createElement('div');
  body.className = 'bubble-text';
  body.textContent = text;
  bubble.appendChild(body);
  return bubble;
}

function createTypingBubble(className: string, label: string): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = className;
  bubble.setAttribute('aria-label', label);
  bubble.innerHTML =
    '<span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>';
  return bubble;
}

/**
 * アイコンと名前つきの発言行（お客さん・お助けエージェント・店長共通）
 * アイコンや名前をクリックすると、その人をメッセージの宛先に選べる
 */
function createSpeakerRow(
  kind: 'customer' | 'agent' | 'owner',
  icon: string,
  name: string,
  bubble: HTMLElement,
  extras: HTMLElement[] = [],
  isContinuation = false,
  recipientKey?: string,
): HTMLElement {
  const row = document.createElement('div');
  row.className = `chat-bubble-row is-speaker is-${kind}${isContinuation ? ' is-continuation' : ''}`;

  const avatar = document.createElement('span');
  avatar.className = `speaker-avatar is-${kind}${isContinuation ? ' is-continuation' : ''}${recipientKey ? ' is-selectable' : ''}`;
  avatar.textContent = icon;
  if (recipientKey) {
    avatar.title = `${name}に話しかける`;
    avatar.addEventListener('click', () => selectRecipientAndFocus(recipientKey));
  }

  const body = document.createElement('div');
  body.className = 'speaker-body';
  if (!isContinuation) {
    const nameEl = document.createElement('div');
    nameEl.className = `speaker-name${recipientKey ? ' is-selectable' : ''}`;
    nameEl.textContent = name;
    if (recipientKey) {
      nameEl.title = `${name}に話しかける`;
      nameEl.addEventListener('click', () => selectRecipientAndFocus(recipientKey));
    }
    body.appendChild(nameEl);
  }

  body.append(bubble, ...extras);
  row.append(avatar, body);
  return row;
}

function speakerKeyOf(msg: Pick<TimelineMessage, 'role' | 'personaId'>): string {
  return msg.role === 'customer' ? `customer:${msg.personaId ?? ''}` : msg.role;
}

function renderChatPanel(): HTMLElement {
  const chatCard = document.createElement('section');
  chatCard.className = 'vibe-chat-card';

  const stream = document.createElement('div');
  const isPlayingQueue =
    isQueueRunning || queueTimers.size > 0 || activeQueuedItem !== null || messageQueue.length > 0;
  stream.className = `vibe-chat-stream ${isPlayingQueue ? 'is-skippable' : ''}`;
  if (isPlayingQueue) stream.title = 'クリックすると次の発言をすぐ表示します';
  // 順番に出している途中の発言は、チャットを押せば1つずつすぐ表示して次に進める（ボタンや入力欄を押したときは除く）
  stream.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, a, select, .is-selectable')) return;
    if (!isPlayingQueue) return;
    advanceOneQueuedMessage();
  });
  chatScrollEl = stream;

  const isBusy = state.chatLoading || state.evaluateLoading;
  const latestSelectorMessageId = [...state.messages].reverse().find((m) => m.showCohortSelector)?.id;
  const latestChallengeMessageId = [...state.messages].reverse().find((m) => m.showNextChallenge)?.id;
  const latestActionChoiceId = [...state.messages]
    .reverse()
    .find((m) => (m.followUps && m.followUps.length > 0) || m.showEvaluateAction)?.id;
  let prevSpeakerKey = '';

  for (const msg of state.messages) {
    // 進行役のアナウンス・AIの作業プログレス・選択肢：吹き出しなしで中央に小さく出す
    if (msg.role === 'system') {
      const isActionChoiceMsg = Boolean(
        (msg.followUps && msg.followUps.length > 0) || msg.showEvaluateAction,
      );
      if (isActionChoiceMsg) {
        if (msg.id !== latestActionChoiceId || isBusy || isPlayingQueue) continue;
        const actionRow = renderActionChoiceRow(msg);
        if (!actionRow) continue;
        const row = document.createElement('div');
        if (msg.text) {
          const line = document.createElement('div');
          line.className = 'chat-system-line';
          line.textContent = msg.text;
          row.appendChild(line);
        }
        row.appendChild(actionRow);
        const isFirstSeen = !seenMessageIds.has(msg.id);
        seenMessageIds.add(msg.id);
        row.className = `chat-system-row${isFirstSeen ? ' is-entering' : ''}`;
        prevSpeakerKey = 'system';
        stream.appendChild(row);
        continue;
      }

      const row = document.createElement('div');
      if (msg.workLog) {
        appendWorkLogLines(row, msg);
      } else if (msg.text) {
        const line = document.createElement('div');
        line.className = `chat-system-line ${msg.tone === 'warning' ? 'is-warning' : ''}`;
        appendFormattedSystemText(line, msg.text);
        row.appendChild(line);
      }
      if (msg.showCohortSelector) {
        row.appendChild(renderCohortSelector(msg, msg.id === latestSelectorMessageId));
      }
      if (msg.showNextChallenge && state.selectedCohortId) {
        row.appendChild(renderNextChallengeSelector(msg, msg.id === latestChallengeMessageId));
      }
      if (row.childNodes.length === 0) continue;

      const isFirstSeen = !seenMessageIds.has(msg.id);
      seenMessageIds.add(msg.id);
      row.className = `chat-system-row${isFirstSeen ? ' is-entering' : ''}`;
      prevSpeakerKey = 'system';
      stream.appendChild(row);
      continue;
    }

    const isFirstSeen = !seenMessageIds.has(msg.id);
    seenMessageIds.add(msg.id);
    const enteringClass = isFirstSeen ? ' is-entering' : '';
    const currentSpeakerKey = speakerKeyOf(msg);
    const isContinuation = currentSpeakerKey === prevSpeakerKey;
    prevSpeakerKey = currentSpeakerKey;

    // お客さんの発言：アイコンと名前つきの吹き出し
    if (msg.role === 'customer') {
      const persona = findPersona(msg.personaId);
      const outcomeClass = msg.review ? ` is-${msg.review.outcome}` : '';
      const bubble = createBubble(`chat-bubble is-customer${outcomeClass}${enteringClass}`, msg.text);
      stream.appendChild(
        createSpeakerRow(
          'customer',
          persona?.icon ?? '客',
          persona?.name ?? 'お客さん',
          bubble,
          [],
          isContinuation,
          'customer',
        ),
      );
      continue;
    }

    // 店長の発言
    if (msg.role === 'owner') {
      const bubble = createBubble(`chat-bubble is-owner${enteringClass}`, msg.text);
      stream.appendChild(
        createSpeakerRow('owner', OWNER.icon, OWNER.name, bubble, [], isContinuation, 'owner'),
      );
      continue;
    }

    // お助けエージェントの発言：進行案内・質問回答・改造完了の報告
    if (msg.role === 'assistant') {
      const bubble = createBubble(`chat-bubble is-agent${enteringClass}`, msg.text);
      stream.appendChild(
        createSpeakerRow('agent', AGENT_ICON, AGENT_NAME, bubble, [], isContinuation, 'assistant'),
      );
      continue;
    }

    // 学習者の発言
    const row = document.createElement('div');
    row.className = 'chat-bubble-row is-user';
    row.appendChild(createBubble(`chat-bubble is-user${enteringClass}`, msg.text));
    stream.appendChild(row);
  }

  const cohortPersonas = state.selectedCohortId ? getReviewersByCohort(state.selectedCohortId) : [];
  const workLogRunning = state.messages.some((m) => m.workLog && !m.workLog.finished);
  const loadingPersona =
    state.chatLoading &&
    !workLogRunning &&
    state.recipient !== 'assistant' &&
    state.recipient !== 'owner'
      ? (findPersona(state.recipient) ?? cohortPersonas[0])
      : undefined;

  // 店長の書き込み中の表示
  if (
    state.typingMessage?.role === 'owner' ||
    (state.chatLoading && !workLogRunning && state.recipient === 'owner')
  ) {
    stream.appendChild(
      createSpeakerRow(
        'owner',
        OWNER.icon,
        OWNER.name,
        createTypingBubble('chat-bubble is-owner is-loading', `${OWNER.name}が書き込み中`),
        [],
        prevSpeakerKey === 'owner',
      ),
    );
  }

  // お客さんの書き込み中の表示
  if (state.typingMessage?.role === 'customer' || loadingPersona) {
    const persona = loadingPersona ?? findPersona(state.typingMessage?.personaId);
    stream.appendChild(
      createSpeakerRow(
        'customer',
        persona?.icon ?? '',
        persona?.name ?? '',
        createTypingBubble('chat-bubble is-customer is-loading', `${persona?.name ?? ''}が書き込み中`),
        [],
        prevSpeakerKey === `customer:${persona?.id ?? ''}`,
      ),
    );
  }

  // お助けエージェントの書き込み中の表示（演出キューまたはAI応答待ち）
  if (
    state.typingMessage?.role === 'assistant' ||
    (state.chatLoading && !workLogRunning && state.recipient === 'assistant')
  ) {
    stream.appendChild(
      createSpeakerRow(
        'agent',
        AGENT_ICON,
        AGENT_NAME,
        createTypingBubble('chat-bubble is-agent is-loading', `${AGENT_NAME}が書き込み中`),
        [],
        prevSpeakerKey === 'assistant',
      ),
    );
  }

  // 反応確認中は状況を表示する
  if (state.evaluateLoading) {
    const row = document.createElement('div');
    row.className = 'chat-system-row';
    const line = document.createElement('div');
    line.className = 'chat-system-line is-progress';
    line.innerHTML = `
      <span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      <span>お客さんが画面を操作しています</span>
    `;
    row.appendChild(line);
    stream.appendChild(row);
  }

  chatCard.appendChild(stream);

  const composer = document.createElement('div');
  composer.className = 'vibe-composer';

  const recipientRow = document.createElement('div');
  recipientRow.className = 'composer-recipient-row';
  const recipientLabel = document.createElement('span');
  recipientLabel.className = 'composer-recipient-label';
  recipientLabel.textContent = '宛先';
  recipientRow.appendChild(recipientLabel);

  const latestEvalForRecipients = findLatestCohortEvaluation()?.evaluation;
  const allCustomersAchieved =
    cohortPersonas.length > 0 &&
    cohortPersonas.every(
      (p) =>
        latestEvalForRecipients?.results.find((r) => r.reviewerId === p.id)?.outcome === 'achieved',
    );
  const recipientOptions: Array<{
    key: string;
    label: string;
    customerIndex?: number;
    achieved?: boolean;
  }> = [
    { key: 'assistant', label: AGENT_NAME },
    { key: 'owner', label: OWNER.name },
    ...(cohortPersonas.length > 0
      ? [
          {
            key: 'customer',
            label: allCustomersAchieved ? '✓ お客さん' : 'お客さん',
            customerIndex: 0,
            achieved: allCustomersAchieved,
          },
        ]
      : []),
  ];
  const isCohortLocked = !state.selectedCohortId;
  const now = performance.now();
  for (const opt of recipientOptions) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.dataset.recipientKey = opt.key;
    pill.disabled = isCohortLocked;
    pill.className = `composer-recipient-pill${state.recipient === opt.key ? ' is-active' : ''}${opt.customerIndex !== undefined ? ' is-customer-pill' : ''}${opt.achieved ? ' is-achieved-customer' : ''}`;
    if (opt.customerIndex !== undefined) {
      pill.title = opt.achieved
        ? 'お客さん全員が満足して注文できました（クリックで話しかける）'
        : 'お客さんに質問する';
      let firstSeen = recipientFirstSeenAt.get(opt.key);
      if (firstSeen === undefined) {
        firstSeen = now;
        recipientFirstSeenAt.set(opt.key, firstSeen);
      }
      const delayMs = opt.customerIndex * RECIPIENT_ENTER_STAGGER_MS;
      const totalMs = delayMs + RECIPIENT_ENTER_DURATION_MS;
      const elapsed = now - firstSeen;
      if (elapsed < totalMs) {
        pill.classList.add('is-entering');
        pill.style.animationDelay = `${Math.round(delayMs - elapsed)}ms`;
      }
    }
    pill.textContent = opt.label;
    pill.addEventListener('click', () => {
      if (isCohortLocked) return;
      selectRecipientAndFocus(opt.key);
    });
    recipientRow.appendChild(pill);
  }

  composer.appendChild(recipientRow);

  const formRow = document.createElement('form');
  formRow.className = 'composer-form-row';
  formRow.addEventListener('submit', (e) => {
    e.preventDefault();
    void handleSendMessage();
  });

  const inputWrap = document.createElement('div');
  inputWrap.className = `composer-input-wrap${state.isRecordingAudio ? ' is-recording' : ''}${state.isTranscribingAudio ? ' is-transcribing' : ''}${isCohortLocked ? ' is-locked' : ''}`;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'composer-input';
  input.disabled = isCohortLocked;
  input.placeholder = isCohortLocked
    ? 'まず上のボタンから、誰のために直すかを選んでください'
    : state.runFinished
      ? '挑戦は終わりました。やり直すとまた手直しできます（店長とお客さんには質問できます）'
      : state.isRecordingAudio
      ? '録音中… 話し終えたら右の停止ボタンを押してください'
      : state.isTranscribingAudio
        ? '音声から指示を整えています…'
        : getRecipientPlaceholder(state.recipient);
  input.value = state.inputText;
  input.addEventListener('input', () => {
    state.inputText = input.value;
    sendBtn.disabled = !state.inputText.trim() || isCohortLocked;
    const switched = resolveExplicitRecipientSwitch(state.inputText);
    if (switched && switched !== state.recipient) {
      state.recipient = switched;
      for (const pillEl of recipientRow.querySelectorAll<HTMLButtonElement>(
        '.composer-recipient-pill',
      )) {
        const active = pillEl.dataset.recipientKey === state.recipient;
        pillEl.classList.toggle('is-active', active);
        if (active) {
          pillEl.classList.remove('is-auto-switched');
          void pillEl.offsetWidth;
          pillEl.classList.add('is-auto-switched');
        }
      }
      input.placeholder = getRecipientPlaceholder(state.recipient);
    }
  });

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = `btn-composer-mic${state.isRecordingAudio ? ' is-recording' : ''}`;
  micBtn.disabled = isCohortLocked || state.chatLoading || state.isTranscribingAudio;
  micBtn.title = isCohortLocked
    ? '先に上のボタンから、誰のために直すかを選んでください'
    : state.isRecordingAudio
      ? '録音を終えて入力欄に反映する'
      : state.isTranscribingAudio
        ? '音声を整えています…'
        : '声で入力する（雑音や言い淀みを省いて入力欄に整えます）';
  micBtn.setAttribute(
    'aria-label',
    state.isRecordingAudio ? '録音を終えて入力欄に反映' : '音声で入力',
  );
  micBtn.innerHTML = state.isRecordingAudio
    ? `${ICONS.micStop}<span>停止</span>`
    : state.isTranscribingAudio
      ? '<span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>'
      : ICONS.mic;
  micBtn.addEventListener('click', () => {
    void toggleVoiceRecording();
  });

  inputWrap.append(input, micBtn);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'btn-composer-send';
  sendBtn.disabled =
    isCohortLocked || !state.inputText.trim() || state.isRecordingAudio || state.isTranscribingAudio;
  sendBtn.textContent = '送信';

  formRow.append(inputWrap, sendBtn);
  if (state.pendingSend) {
    const note = document.createElement('div');
    note.className = 'composer-pending-note';
    note.textContent = '返事が届いたら送ります';
    composer.appendChild(note);
  }
  composer.appendChild(formRow);

  chatCard.appendChild(composer);
  return chatCard;
}

function ensureStudioShellInitialized(): void {
  if (!appRoot || shellEl) return;

  shellEl = document.createElement('div');
  shellEl.className = 'studio-shell';

  headerSlotEl = document.createElement('div');
  headerSlotEl.className = 'studio-header-slot';
  shellEl.appendChild(headerSlotEl);

  const stage = document.createElement('main');
  stage.className = 'game-stage';

  const deviceColumn = document.createElement('section');
  deviceColumn.className = 'device-column';

  phoneFrameEl = document.createElement('div');
  phoneFrameEl.className = 'smartphone-bezel';

  sandboxStageEl = document.createElement('div');
  sandboxStageEl.className = 'sandbox-viewport';

  sandboxAppMountEl = document.createElement('div');
  sandboxAppMountEl.className = 'sandbox-app-mount';
  sandboxStageEl.appendChild(sandboxAppMountEl);

  penCanvasEl = document.createElement('canvas');
  penCanvasEl.className = 'pen-overlay-canvas';
  sandboxStageEl.appendChild(penCanvasEl);
  attachPenEvents(penCanvasEl, sandboxStageEl);

  phoneFrameEl.appendChild(sandboxStageEl);

  bottomBarEl = document.createElement('div');
  bottomBarEl.className = 'device-bottom-bar';

  deviceColumn.append(phoneFrameEl, bottomBarEl);

  chatSlotEl = document.createElement('div');
  chatSlotEl.className = 'chat-column-slot';

  stage.append(deviceColumn, chatSlotEl);
  shellEl.appendChild(stage);

  const watermark = document.createElement('footer');
  watermark.className = 'studio-watermark';
  watermark.textContent = 'ポンコツ工房';
  shellEl.appendChild(watermark);

  appRoot.innerHTML = '';
  appRoot.appendChild(shellEl);
}

function renderStudio(): void {
  if (!appRoot) return;
  ensureStudioShellInitialized();
  const spec = getCurrentSpec();

  const activeEl = document.activeElement;
  const focusedClass =
    activeEl instanceof HTMLInputElement && activeEl.classList.contains('composer-input')
      ? 'composer-input'
      : null;
  const selectionStart = activeEl instanceof HTMLInputElement ? activeEl.selectionStart : null;
  const selectionEnd = activeEl instanceof HTMLInputElement ? activeEl.selectionEnd : null;
  const prevScrollTop = chatScrollEl ? chatScrollEl.scrollTop : 0;

  if (headerSlotEl) {
    headerSlotEl.innerHTML = '';
    const header = document.createElement('header');
    header.className = 'studio-header';

    const cohort = state.selectedCohortId
      ? TARGET_COHORTS.find((c) => c.id === state.selectedCohortId)
      : undefined;
    const cohortPersonas = state.selectedCohortId
      ? getReviewersByCohort(state.selectedCohortId)
      : [];
    const evalRes = evaluationFor(getCurrentCheckpoint());
    const achievedOf = (e: EvaluationResponse) =>
      e.results.filter((r) => r.outcome === 'achieved').length;
    const prevEval = !evalRes
      ? findLatestCohortEvaluation(state.activeCheckpointIndex - 1)?.evaluation
      : undefined;
    const previous = prevEval ? { evalRes: prevEval, achieved: achievedOf(prevEval) } : undefined;

    const goalGroup = document.createElement('div');
    goalGroup.className = 'goal-status-group';

    const cohortBadge = document.createElement('div');
    cohortBadge.className = `goal-cohort-badge${cohort ? '' : ' is-empty'}`;
    const cohortLabelEl = document.createElement('span');
    cohortLabelEl.className = 'goal-badge-prefix';
    cohortLabelEl.textContent = '対象';
    const cohortNameEl = document.createElement('span');
    cohortNameEl.className = 'goal-cohort-name';
    cohortNameEl.textContent = cohort ? cohort.label : '未選択';
    cohortBadge.append(cohortLabelEl, cohortNameEl);

    const progressBadge = document.createElement('div');
    const activeEval = evalRes ?? previous?.evalRes;
    const currentAchieved = evalRes ? achievedOf(evalRes) : (previous?.achieved ?? 0);
    const isCleared = Boolean(
      cohortPersonas.length > 0 && evalRes && currentAchieved === cohortPersonas.length,
    );
    const isUnverified = Boolean(state.selectedCohortId && !evalRes && state.checkpoints.length > 1);
    progressBadge.className = `goal-progress-badge${isCleared ? ' is-cleared' : ''}${isUnverified ? ' is-unverified' : ''}${cohort ? '' : ' is-empty'}`;

    const progressPrefixEl = document.createElement('span');
    progressPrefixEl.className = 'goal-badge-prefix';
    progressPrefixEl.textContent = '満足';

    const dotsWrap = document.createElement('span');
    dotsWrap.className = 'goal-progress-dots';
    const dotCount = cohortPersonas.length > 0 ? cohortPersonas.length : 3;
    for (let i = 0; i < dotCount; i++) {
      const persona = cohortPersonas[i];
      const dot = document.createElement('span');
      const personaAchieved =
        persona &&
        activeEval?.results.find((r) => r.reviewerId === persona.id)?.outcome === 'achieved';
      dot.className = `goal-dot${personaAchieved ? ' is-achieved' : ''}${!evalRes && previous ? ' is-pending' : ''}`;
      if (persona) {
        dot.title = `${persona.name}：${personaAchieved ? '満足して注文できた' : 'まだ困っている'}`;
      }
      dotsWrap.appendChild(dot);
    }

    if (isUnverified) {
      progressBadge.title = '画面を手直ししました。「お客さんの反応を見る」で確かめられます';
    } else if (cohort) {
      progressBadge.title = `満足して注文できた人数：${currentAchieved}/${dotCount}人`;
    }

    progressBadge.append(progressPrefixEl, dotsWrap);

    const voiceToggleBtn = document.createElement('button');
    voiceToggleBtn.type = 'button';
    voiceToggleBtn.className = `header-voice-toggle${state.voiceEnabled ? '' : ' is-off'}`;
    const voiceLabel = state.voiceEnabled
      ? '音声読み上げをオフにする'
      : '音声読み上げはオフになっています（クリックでオンに戻す）';
    voiceToggleBtn.title = voiceLabel;
    voiceToggleBtn.setAttribute('aria-label', voiceLabel);
    voiceToggleBtn.innerHTML = state.voiceEnabled ? ICONS.volumeOn : ICONS.volumeOff;
    voiceToggleBtn.addEventListener('click', () => {
      state.voiceEnabled = !state.voiceEnabled;
      if (!state.voiceEnabled) {
        stopAllTtsPlayback();
      }
      renderStudio();
    });

    const headerChatBar = document.createElement('div');
    headerChatBar.className = 'header-chat-bar';

    goalGroup.append(cohortBadge, progressBadge);
    headerChatBar.append(goalGroup, voiceToggleBtn);
    header.appendChild(headerChatBar);

    headerSlotEl.appendChild(header);
  }

  if (phoneFrameEl) {
    phoneFrameEl.className = `smartphone-bezel ${state.interactionMode === 'pen' ? 'is-pen-active' : ''}`;
  }

  if (bottomBarEl) {
    bottomBarEl.innerHTML = '';
    const modeSwitch = document.createElement('div');
    modeSwitch.className = 'bottom-mode-switch';

    const playModeBtn = document.createElement('button');
    playModeBtn.type = 'button';
    playModeBtn.className = `header-mode-btn ${state.interactionMode === 'play' ? 'is-active' : ''}`;
    playModeBtn.innerHTML = `${ICONS.cursor}<span>操作する</span>`;
    playModeBtn.addEventListener('click', () => {
      state.interactionMode = 'play';
      renderStudio();
    });

    const penModeBtn = document.createElement('button');
    penModeBtn.type = 'button';
    penModeBtn.className = `header-mode-btn is-pen ${state.interactionMode === 'pen' ? 'is-active' : ''}`;
    penModeBtn.disabled = !state.selectedCohortId;
    if (!state.selectedCohortId) {
      penModeBtn.title = '先にチャットで、誰のために直すかを選んでください';
    }
    penModeBtn.innerHTML = `${ICONS.pen}<span>赤ペンで囲む</span>`;
    penModeBtn.addEventListener('click', () => {
      if (!state.selectedCohortId) return;
      state.interactionMode = 'pen';
      renderStudio();
    });

    modeSwitch.append(playModeBtn, penModeBtn);

    const hasUnevaluatedChanges =
      state.checkpoints.length > 1 && !evaluationFor(getCurrentCheckpoint());
    const evalBtn = document.createElement('button');
    evalBtn.type = 'button';
    evalBtn.className = `btn-bottom-evaluate ${hasUnevaluatedChanges ? 'is-ready' : ''}`;
    // 誰のために改造するかを選ぶまでは、お客さんが来ていないので反応を見られない
    evalBtn.disabled = state.evaluateLoading || !state.selectedCohortId || state.runFinished;
    // 押せない間は目立たない色にして、最初に目が行かないようにする
    evalBtn.classList.toggle('is-locked', !state.selectedCohortId);
    if (!state.selectedCohortId) evalBtn.title = '先にチャットで、誰のために直すかを選んでください';
    evalBtn.innerHTML = `${ICONS.evaluate}<span>${
      state.evaluateLoading ? '反応を確認中...' : 'お客さんの反応を見る'
    }</span>`;
    evalBtn.addEventListener('click', () => {
      void handleEvaluate();
    });

    bottomBarEl.append(modeSwitch, evalBtn);
  }

  if (chatSlotEl) {
    chatSlotEl.innerHTML = '';
    const chatPanel = renderChatPanel();
    chatSlotEl.appendChild(chatPanel);
    if (chatScrollEl) {
      chatScrollEl.scrollTop = prevScrollTop;
    }
  }

  // スマホ画面の仕様・状態・選択部品が変わったときだけサンドボックスを再描画する（顧客層切替等では一切リロードしない）
  const nextSandboxKey = JSON.stringify({
    spec,
    liveAppState: state.liveAppState,
    circled: state.circledComponentIds,
    // 作業ログの行を押したときに部品を光らせるため、光らせる部品が変わったときも描き直す
    justChanged: state.justChangedIds,
  });
  if (sandboxAppMountEl && nextSandboxKey !== lastSandboxRenderKey) {
    lastSandboxRenderKey = nextSandboxKey;
    renderSandboxApp(
      sandboxAppMountEl,
      spec,
      state.liveAppState,
      new Set(state.circledComponentIds),
      {
        justChangedIds: new Set(state.justChangedIds),
        onStateChange: (nextState) => {
          state.liveAppState = nextState;
          renderStudio();
        },
        onStatePatch: (patch) => {
          state.liveAppState = withDerivedValues(getCurrentSpec(), {
            ...state.liveAppState,
            ...patch,
          });
          renderStudio();
        },
        onNotice: (msg, t) => postSandboxNotice(msg, t),
      },
    );
  }

  if (focusedClass && shellEl) {
    const nextInput = shellEl.querySelector<HTMLInputElement>(`.${focusedClass}`);
    if (nextInput) {
      nextInput.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        nextInput.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }

  window.requestAnimationFrame(() => {
    redrawPenCanvas();
  });
}

window.addEventListener('resize', () => {
  redrawPenCanvas();
});

playInitialWelcomeSequence();
