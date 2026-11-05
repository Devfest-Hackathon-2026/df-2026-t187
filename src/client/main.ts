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
  detectExplicitRecipientMention,
} from '../shared/intent.ts';
import { buildOwnerClosingLines } from '../shared/owner.ts';
import { simulatePersonaComputerUse } from '../shared/sandboxValidator.ts';
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
  /** 改造完了後にチャット内からも「お客さんの反応を見る」を押せるようにする */
  showEvaluateAction?: boolean;
  /** この発言が対象にしている、赤ペンで囲んだ部品 */
  targetComponentIds?: string[];
  /** 改造の作業の過程。システムのメッセージとして1行ずつ進み、完了後もそのまま残す */
  workLog?: {
    steps: Array<{ text: string; done: boolean }>;
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
  chatLoading: boolean;
  evaluateLoading: boolean;
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
  chatLoading: false,
  evaluateLoading: false,
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

/** 今の画面か、それより前で一番新しくお客さんの反応を見た画面の、操作の記録 */
function buildLatestReviewRecord(): LatestReviewRecord | undefined {
  for (let i = state.activeCheckpointIndex; i >= 0; i--) {
    const cp = state.checkpoints[i];
    const evaluation = evaluationFor(cp);
    if (!evaluation) continue;
    return {
      screenLabel: formatCheckpointLabel(cp),
      isCurrentScreen: i === state.activeCheckpointIndex,
      reviews: evaluation.results.map((r) => ({
        name: findPersona(r.reviewerId)?.name ?? r.reviewerId,
        outcome: r.outcome,
        actionTrace: r.actionTrace ?? [],
      })),
    };
  }
  return undefined;
}

function findPersona(personaId: string | undefined): ReviewerPersona | undefined {
  if (!personaId) return undefined;
  return ALL_REVIEWER_PERSONAS.find((p) => p.id === personaId);
}

function pushMessage(msg: Omit<TimelineMessage, 'id'>): TimelineMessage {
  const full: TimelineMessage = {
    id: `${msg.role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...msg,
  };
  state.messages.push(full);
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
let queueTimer: number | null = null;

/** 発言の長さに応じた書き込み時間（1文ずつじっくり読めるテンポにする） */
function typingDurationFor(text: string): number {
  return Math.min(2400, 1000 + text.length * 45);
}

/** 長い発言を句点や改行で短く区切り、チャットらしく1文ずつ送れるようにする */
function splitIntoChatChunks(text: string): string[] {
  // 「★今だけ！今すぐ購入★」のように、★や括弧の内側にある！や。では区切らない
  const parts: string[] = [];
  let current = '';
  let inStar = false;
  let bracketDepth = 0;
  for (const ch of text) {
    if (ch === '\n') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (ch === '★') inStar = !inStar;
    else if ('「『（('.includes(ch)) bracketDepth++;
    else if ('」』）)'.includes(ch)) bracketDepth = Math.max(0, bracketDepth - 1);
    else if ('。！？!?'.includes(ch) && !inStar && bracketDepth === 0) {
      parts.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [text.trim()];
}

function enqueueMessages(items: QueuedMessage[]): void {
  messageQueue.push(...items);
  if (queueTimer === null) {
    playNextQueuedMessage();
  }
}

function playNextQueuedMessage(): void {
  const next = messageQueue.shift();
  if (!next) {
    queueTimer = null;
    state.typingMessage = undefined;
    renderStudio();
    return;
  }

  state.typingMessage =
    next.typingMs > 0 ? { role: next.message.role, personaId: next.message.personaId } : undefined;
  renderStudio();
  scrollToLatestMessage();

  queueTimer = window.setTimeout(() => {
    state.typingMessage = undefined;
    pushMessage(next.message);
    renderStudio();
    scrollToLatestMessage();
    queueTimer = window.setTimeout(playNextQueuedMessage, QUEUE_PAUSE_MS);
  }, next.typingMs > 0 ? next.typingMs : QUEUE_PAUSE_MS);
}

/** 学習者が先に操作したときは、残りの発言を待たずにすべて出して順序を保つ */
function flushMessageQueue(): void {
  if (queueTimer !== null) {
    window.clearTimeout(queueTimer);
    queueTimer = null;
  }
  state.typingMessage = undefined;
  while (messageQueue.length > 0) {
    pushMessage(messageQueue.shift()!.message);
  }
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
  const selector = [...state.messages].reverse().find((m) => m.showCohortSelector);
  if (selector) selector.chosenCohortId = cohortId;
  startCohort(cohortId);
}

/** クリア後に、直した画面のまま別の顧客層のお客さんを呼ぶ */
function handleCallNextCohort(cohortId: TargetCohortId): void {
  flushMessageQueue();
  state.selectedCohortId = undefined;
  state.recipient = 'assistant';
  recipientFirstSeenAt.clear();
  startCohort(cohortId);
}

/** クリア後に、画面を最初に戻して顧客層を選び直す */
function handleRestartFromScratch(): void {
  flushMessageQueue();
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
  const selectorLine = ACTIVE_THEME.introScript.find((l) => l.showCohortSelector);
  pushMessage({ role: 'system', text: '画面を最初の状態に戻しました' });
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
  return state.messages.slice(-12).map((m) => ({
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
  // 改造中や質問への回答待ちのときは割り込まない。囲みへの反応を待っている間の囲み直しは、新しい方を使う
  if (state.chatLoading && !circleInFlight) return;
  const seq = ++circleRequestSeq;
  circleInFlight = true;
  flushMessageQueue();
  // 前に囲んだときの反応がチャットの最後に残っていれば、置き換える
  while (state.messages.length > 0 && state.messages[state.messages.length - 1].circleReaction) {
    state.messages.pop();
  }
  state.topicTargetIds = [...targetIds];
  state.chatLoading = true;
  renderStudio();
  scrollToLatestMessage();
  try {
    const data = await postJson<ChatResponse>('/api/chat', {
      currentSpec: getCurrentSpec(),
      latestReviews: buildLatestReviewRecord(),
      targetComponentIds: targetIds,
      userMessage: '',
      cohortId: state.selectedCohortId,
      history: buildChatHistory(),
      mode: 'circled',
    });
    if (seq !== circleRequestSeq) return;
    const chunks = splitIntoChatChunks(data.reply);
    chunks.forEach((chunk, i) =>
      pushMessage({
        role: 'assistant',
        text: chunk,
        targetComponentIds: targetIds,
        circleReaction: true,
        followUps: i === chunks.length - 1 ? data.suggestedFollowUps : undefined,
      }),
    );
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

/** 作業ログの行を足す。前の行は終わったことにする */
function addWorkStep(log: NonNullable<TimelineMessage['workLog']>, text: string, done = false): void {
  for (const step of log.steps) step.done = true;
  log.steps.push({ text, done });
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
    renderStudio();
    scrollToLatestMessage();
  } else {
    // 準備中の行は消して、実際に行った作業の行だけをシステムメッセージとして残す
    log.steps = [];
    for (const step of steps) {
      state.justChangedIds = step.componentId ? [step.componentId] : [];
      addWorkStep(log, step.text, true);
      await sleep(WORK_STEP_INTERVAL_MS);
    }
    state.justChangedIds = [];
    if (log.steps.length === 0) {
      addWorkStep(log, '画面を書き換えました', true);
    }
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
  const cohortPersonas = state.selectedCohortId
    ? getReviewersByCohort(state.selectedCohortId)
    : [];
  const mentioned = detectExplicitRecipientMention(text, cohortPersonas);
  if (!mentioned) return null;
  if (mentioned === 'assistant' || mentioned === 'owner') return mentioned;
  if (cohortPersonas.some((p) => p.id === mentioned)) return mentioned;
  return null;
}

async function handleSendMessage(
  overrideText?: string,
  targetIdsOverride?: string[],
  options: { hideUserBubble?: boolean } = {},
): Promise<void> {
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

  if (overrideText === undefined) {
    const switched = resolveExplicitRecipientSwitch(text);
    if (switched) state.recipient = switched;
  }

  const spec = getCurrentSpec();
  const recipientSnapshot = overrideText !== undefined ? 'assistant' : state.recipient;
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

  // 画面のボタンから自動で尋ねるときは、学習者が打ったように見せない
  if (!options.hideUserBubble) {
    pushMessage({ role: 'user', text, targetComponentIds: targetIdsSnapshot });
  }
  if (overrideText === undefined) {
    state.inputText = '';
  }
  state.penPoints = [];
  state.circledComponentIds = [];
  state.chatLoading = true;
  // はっきりした改造の指示（かつ店長やお客さん宛てでないとき）なら、返事を待つ間から作業の過程をシステムメッセージで見せる
  const canApplyDirectly = recipientSnapshot === 'assistant';
  let logMessage: TimelineMessage | undefined =
    canApplyDirectly && classifyUserMessageIntent(text) === 'apply'
      ? startWorkLog(targetIdsSnapshot)
      : undefined;
  const logTimers: number[] = [];
  if (logMessage) {
    const log = logMessage.workLog!;
    logTimers.push(
      window.setTimeout(() => !log.finished && addWorkStep(log, '画面の部品を調べています'), 900),
      window.setTimeout(() => !log.finished && addWorkStep(log, '変え方を考えています'), 2200),
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
          showEvaluateAction: hasWorkingOrder,
        });

        if (applied.ownerFacts && applied.ownerFacts.length > 0) {
          state.chatLoading = false;
          void speakOwner({
            situation: 'change',
            facts: applied.ownerFacts,
            fallback: applied.ownerReaction ?? '',
          });
          return;
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
      // お客さんに話しかけたときは、そのお客さん本人が返事をする
      if (logMessage) state.messages = state.messages.filter((m) => m !== logMessage);
      state.chatLoading = false;
      const personaId = data.customerPersonaId;
      enqueueMessages(
        splitIntoChatChunks(data.reply).map((chunk, i) => ({
          message: { role: 'customer' as const, personaId, text: chunk },
          typingMs: i === 0 ? 400 : typingDurationFor(chunk),
        })),
      );
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
        followUps: restChunks.length === 0 ? data.suggestedFollowUps : undefined,
      });
      if (restChunks.length > 0) {
        state.chatLoading = false;
        enqueueMessages(
          restChunks.map((chunk, idx) => ({
            message: {
              role: 'assistant' as const,
              text: chunk,
              targetComponentIds: targetIdsSnapshot,
              followUps: idx === restChunks.length - 1 ? data.suggestedFollowUps : undefined,
            },
            typingMs: typingDurationFor(chunk),
          })),
        );
        return;
      }
    }
  } catch (err) {
    logTimers.forEach((t) => window.clearTimeout(t));
    if (logMessage?.workLog && !logMessage.workLog.finished) {
      addWorkStep(logMessage.workLog, '途中で止まりました', true);
      logMessage.workLog.finished = true;
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
async function speakOwner(req: Omit<OwnerLineRequest, 'history'>): Promise<void> {
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
  if (chunks.length === 0) {
    renderStudio();
    return;
  }
  // 1つ目はすでに書き込み中を見せて待たせたので、すぐ出す
  enqueueMessages(
    chunks.map((chunk, i) => ({
      message: { role: 'owner' as const, text: chunk },
      typingMs: i === 0 ? 300 : typingDurationFor(chunk),
    })),
  );
}

async function handleEvaluate(): Promise<void> {
  if (state.evaluateLoading || !state.selectedCohortId) return;
  flushMessageQueue();
  state.evaluateLoading = true;
  renderStudio();
  scrollToLatestMessage();

  try {
    const activePersonas = getReviewersByCohort(state.selectedCohortId);
    const componentBounds = sandboxStageEl ? collectComponentRects(sandboxStageEl) : undefined;

    const evaluation = await postJson<EvaluationResponse>('/api/evaluate', {
      currentSpec: getCurrentSpec(),
      cohortId: state.selectedCohortId,
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
      const remaining = TARGET_COHORTS.filter((c) => !state.clearedCohortIds.includes(c.id));
      const closing =
        remaining.length > 0
          ? ['おつかれさまでした！', 'ほかのお客さんにもチャレンジしますか？']
          : [
              'おつかれさまでした！すべてのお客さんでクリアです',
              'ほかの直し方も試したくなったら、続けていつでも指示してくださいね',
            ];
      closing.forEach((line, i) => {
        queued.push({
          message: {
            role: 'assistant',
            text: line,
            showNextChallenge: remaining.length > 0 && i === closing.length - 1,
          },
          typingMs: typingDurationFor(line),
        });
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

function jumpToCheckpoint(index: number): void {
  if (index < 0 || index >= state.checkpoints.length) return;
  state.activeCheckpointIndex = index;
  const spec = getCurrentSpec();
  state.liveAppState = createInitialState(spec);
  state.penPoints = [];
  state.circledComponentIds = [];
  state.topicTargetIds = [];
  renderStudio();
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

/** 準備の行は、終わったら過去形で見せる */
const PREP_STEP_DONE_TEXT: Record<string, string> = {
  指示を読んでいます: '指示を読みました',
  画面の部品を調べています: '画面の部品を調べました',
  変え方を考えています: '変え方を決めました',
};

/** 改造の作業ログ。システムメッセージ領域に1行ずつ表示し、完了後もそのまま残す */
function renderWorkLog(msg: TimelineMessage): HTMLElement {
  const log = msg.workLog!;
  const wrap = document.createElement('div');
  wrap.className = `system-worklog ${log.finished ? 'is-finished' : 'is-running'}`;
  const list = document.createElement('ul');
  list.className = 'worklog-list is-system';
  for (const step of log.steps) {
    const item = document.createElement('li');
    item.className = step.done ? 'is-done' : 'is-active';
    const mark = document.createElement('span');
    mark.className = 'worklog-mark';
    mark.textContent = step.done ? '✓' : '';
    const text = document.createElement('span');
    text.textContent = step.done ? (PREP_STEP_DONE_TEXT[step.text] ?? step.text) : step.text;
    item.append(mark, text);
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

const AGENT_NAME = 'お助けAI';
const AGENT_ICON = '助';

function getRecipientPlaceholder(
  recipient: string,
  cohortPersonas: ReviewerPersona[],
): string {
  if (recipient === 'owner') {
    return `${OWNER.name}に話しかける（例：定期便のチェック外してもいい？）`;
  }
  const selectedPersona = cohortPersonas.find((p) => p.id === recipient);
  if (selectedPersona) {
    return `${selectedPersona.name}に聞く（例：どこで困ったの？）`;
  }
  return 'お助けAIに手直しの指示や質問を入力（例：注文ボタンを動くように直して）';
}

function selectRecipientAndFocus(recipient: string): void {
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
  const isPlayingQueue = queueTimer !== null || messageQueue.length > 0;
  stream.className = `vibe-chat-stream ${isPlayingQueue ? 'is-skippable' : ''}`;
  if (isPlayingQueue) stream.title = 'クリックすると続きをすぐ表示します';
  // 順番に出している途中の発言は、チャットを押せば待たずにすべて出す（ボタンや入力欄を押したときは除く）
  stream.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, a, select, .is-selectable')) return;
    if (queueTimer === null && messageQueue.length === 0) return;
    flushMessageQueue();
    renderStudio();
    scrollToLatestMessage();
  });
  chatScrollEl = stream;

  const lastAssistantMessageId = [...state.messages]
    .reverse()
    .find((m) => m.role === 'assistant')?.id;
  const isBusy = state.chatLoading || state.evaluateLoading;
  const latestSelectorMessageId = [...state.messages].reverse().find((m) => m.showCohortSelector)?.id;
  let prevSpeakerKey = '';

  for (const msg of state.messages) {
    const isFirstSeen = !seenMessageIds.has(msg.id);
    seenMessageIds.add(msg.id);
    const enteringClass = isFirstSeen ? ' is-entering' : '';
    const currentSpeakerKey = speakerKeyOf(msg);
    const isContinuation = currentSpeakerKey === prevSpeakerKey;
    prevSpeakerKey = currentSpeakerKey;

    // 進行役のアナウンス・AIの作業プログレス：吹き出しなしで中央に小さく出す
    if (msg.role === 'system') {
      const row = document.createElement('div');
      row.className = `chat-system-row${enteringClass}`;
      if (msg.workLog) {
        row.appendChild(renderWorkLog(msg));
      } else {
        const line = document.createElement('div');
        line.className = `chat-system-line ${msg.tone === 'warning' ? 'is-warning' : ''}`;
        line.textContent = msg.text;
        row.appendChild(line);
      }
      if (msg.showCohortSelector) {
        row.appendChild(renderCohortSelector(msg, msg.id === latestSelectorMessageId));
      }
      stream.appendChild(row);
      continue;
    }

    // お客さんの発言：アイコンと名前つきの吹き出し
    if (msg.role === 'customer') {
      const persona = findPersona(msg.personaId);
      const outcomeClass = msg.review ? ` is-${msg.review.outcome}` : '';
      const bubble = createBubble(`chat-bubble is-customer${outcomeClass}${enteringClass}`, msg.text);
      stream.appendChild(
        createSpeakerRow(
          'customer',
          persona?.icon ?? '',
          persona?.name ?? '',
          bubble,
          [],
          isContinuation,
          persona?.id,
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
      const extras: HTMLElement[] = [];
      if (msg.id === lastAssistantMessageId && !isBusy && !isPlayingQueue) {
        if (msg.showNextChallenge && state.selectedCohortId) {
          const chipRow = document.createElement('div');
          chipRow.className = 'followup-chip-row';
          for (const c of TARGET_COHORTS) {
            if (state.clearedCohortIds.includes(c.id) || c.id === state.selectedCohortId) continue;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'followup-chip is-evaluate-chip';
            chip.textContent = `この画面のまま${c.label}を呼ぶ`;
            chip.addEventListener('click', () => handleCallNextCohort(c.id));
            chipRow.appendChild(chip);
          }
          const restart = document.createElement('button');
          restart.type = 'button';
          restart.className = 'followup-chip';
          restart.textContent = '最初の画面からやり直す';
          restart.addEventListener('click', () => handleRestartFromScratch());
          chipRow.appendChild(restart);
          extras.push(chipRow);
        } else if (
          (msg.followUps && msg.followUps.length > 0) ||
          (msg.showEvaluateAction && !evaluationFor(getCurrentCheckpoint()) && state.selectedCohortId)
        ) {
          const chipRow = document.createElement('div');
          chipRow.className = 'followup-chip-row';
          if (msg.showEvaluateAction && !evaluationFor(getCurrentCheckpoint()) && state.selectedCohortId) {
            const evalChip = document.createElement('button');
            evalChip.type = 'button';
            evalChip.className = 'followup-chip is-evaluate-chip';
            evalChip.textContent = 'お客さんの反応を見る';
            evalChip.addEventListener('click', () => {
              void handleEvaluate();
            });
            chipRow.appendChild(evalChip);
          }
          for (const followUp of msg.followUps ?? []) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'followup-chip';
            chip.textContent = followUp;
            chip.addEventListener('click', () => {
              void handleSendMessage(followUp, msg.targetComponentIds);
            });
            chipRow.appendChild(chip);
          }
          extras.push(chipRow);
        }
      }
      stream.appendChild(
        createSpeakerRow('agent', AGENT_ICON, AGENT_NAME, bubble, extras, isContinuation, 'assistant'),
      );
      continue;
    }

    // 学習者の発言
    const row = document.createElement('div');
    row.className = 'chat-bubble-row is-user';
    row.appendChild(createBubble(`chat-bubble is-user${enteringClass}`, msg.text));
    stream.appendChild(row);
  }

  const workLogRunning = state.messages.some((m) => m.workLog && !m.workLog.finished);
  const loadingPersona =
    state.chatLoading &&
    !workLogRunning &&
    state.recipient !== 'assistant' &&
    state.recipient !== 'owner'
      ? findPersona(state.recipient)
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

  const cohortPersonas = state.selectedCohortId ? getReviewersByCohort(state.selectedCohortId) : [];
  const recipientOptions: Array<{ key: string; label: string; customerIndex?: number }> = [
    { key: 'assistant', label: AGENT_NAME },
    { key: 'owner', label: OWNER.name },
    ...cohortPersonas.map((p, idx) => ({ key: p.id, label: p.name, customerIndex: idx })),
  ];
  const now = performance.now();
  for (const opt of recipientOptions) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.dataset.recipientKey = opt.key;
    pill.className = `composer-recipient-pill${state.recipient === opt.key ? ' is-active' : ''}${opt.customerIndex !== undefined ? ' is-customer-pill' : ''}`;
    if (opt.customerIndex !== undefined) {
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
      state.recipient = opt.key;
      renderStudio();
      window.requestAnimationFrame(() => {
        shellEl?.querySelector<HTMLInputElement>('.composer-input')?.focus();
      });
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

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'composer-input';
  input.placeholder = getRecipientPlaceholder(state.recipient, cohortPersonas);
  input.value = state.inputText;
  input.addEventListener('input', () => {
    state.inputText = input.value;
    sendBtn.disabled = !state.inputText.trim();
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
      input.placeholder = getRecipientPlaceholder(state.recipient, cohortPersonas);
    }
  });

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'btn-composer-send';
  sendBtn.disabled = !state.inputText.trim();
  sendBtn.textContent = '送信';

  formRow.append(input, sendBtn);
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
    activeEl instanceof HTMLInputElement
      ? activeEl.classList.contains('composer-input')
        ? 'composer-input'
        : activeEl.classList.contains('inline-reason-input')
          ? 'inline-reason-input'
          : null
      : null;
  const selectionStart = activeEl instanceof HTMLInputElement ? activeEl.selectionStart : null;
  const selectionEnd = activeEl instanceof HTMLInputElement ? activeEl.selectionEnd : null;
  const prevScrollTop = chatScrollEl ? chatScrollEl.scrollTop : 0;

  if (headerSlotEl) {
    headerSlotEl.innerHTML = '';
    if (state.checkpoints.length > 1 || state.selectedCohortId) {
      const header = document.createElement('header');
      header.className = 'studio-header';

      if (state.checkpoints.length > 1) {
        const cpBar = document.createElement('div');
        cpBar.className = 'checkpoint-bar';
        state.checkpoints.forEach((cp, idx) => {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = `checkpoint-pill ${idx === state.activeCheckpointIndex ? 'is-active' : ''}`;
          pill.textContent = formatCheckpointLabel(cp);
          pill.addEventListener('click', () => jumpToCheckpoint(idx));
          cpBar.appendChild(pill);
        });
        header.appendChild(cpBar);
        requestAnimationFrame(() => {
          const active = cpBar.querySelector<HTMLElement>('.checkpoint-pill.is-active');
          active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      }

      if (state.selectedCohortId) {
        const cohort = TARGET_COHORTS.find((c) => c.id === state.selectedCohortId);
        const evalRes = evaluationFor(getCurrentCheckpoint());
        const goalBadge = document.createElement('div');
        goalBadge.className = 'goal-status-bar';
        const goal = `目標 ${cohort?.label ?? ''} 3人全員が満足して注文できること`;
        const achievedOf = (e: EvaluationResponse) =>
          e.results.filter((r) => r.outcome === 'achieved').length;
        // 今の画面を試していなければ、それより前で最後に試した画面の結果を添えて、試すよう促す
        let previous: { label: string; achieved: number } | undefined;
        for (let i = state.activeCheckpointIndex - 1; i >= 0 && !evalRes; i--) {
          const e = evaluationFor(state.checkpoints[i]);
          if (e) {
            const cp = state.checkpoints[i];
            previous = { label: formatCheckpointLabel(cp), achieved: achievedOf(e) };
            break;
          }
        }
        if (evalRes) {
          goalBadge.textContent = `達成 ${achievedOf(evalRes)}/3人｜${goal}`;
        } else if (previous) {
          goalBadge.textContent = `未確認（${previous.label}は${previous.achieved}/3人）｜${goal}`;
        } else {
          goalBadge.textContent = `未確認（0/3人）｜${goal}`;
        }
        goalBadge.title = goalBadge.textContent ?? '';
        header.appendChild(goalBadge);
      }

      headerSlotEl.appendChild(header);
    }
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
    penModeBtn.innerHTML = `${ICONS.pen}<span>赤ペンで囲む</span>`;
    penModeBtn.addEventListener('click', () => {
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
    evalBtn.disabled = state.evaluateLoading || !state.selectedCohortId;
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
