import { detectHitComponents, type Point2D, type Rect2D } from '../shared/hitTest.ts';
import { createInitialState, hasCompletionAction, withDerivedValues } from '../shared/appRuntime.ts';
import { ACTIVE_THEME, getReviewersByCohort, TARGET_COHORTS } from '../shared/initialTheme.ts';
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
  RecordDecisionRequest,
  RecordDecisionResponse,
  ReviewDisposition,
  ReviewerDispositionRecord,
  ReviewerPersona,
  ReviewOutcome,
  StateValue,
  TargetCohortId,
} from '../shared/types.ts';
import { ICONS } from './icons.ts';
import { querySandboxComponentElements, renderSandboxApp } from './sandboxRenderer.ts';
import { captureSandboxSnapshot } from './snapshot.ts';

/**
 * チャットの発言者
 * - system: スマホ画面の操作通知・エラー表示のみ
 * - assistant: お助けエージェント（進行案内・事実の説明・改造の実行報告）
 * - customer: お客さん本人の発言（来店時の希望・反応確認時の感想）
 * - owner: 依頼主の店長（変更直後に売上・定期便の立場からリアクション）
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
  /** 改造完了後にチャット内からも「お客さんの反応を見る」を押せるようにする */
  showEvaluateAction?: boolean;
  /** この発言が対象にしている、赤ペンで囲んだ部品 */
  targetComponentIds?: string[];
  /** お助けエージェントの回答に続けて押せる返信候補 */
  followUps?: string[];
  /** お客さんの反応と、それに対する採否 */
  review?: {
    outcome: ReviewOutcome;
    disposition?: ReviewerDispositionRecord;
    draft?: { disposition: ReviewDisposition; reason: string };
  };
}

interface StudioState {
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
  /** 書き込み中として表示している発言者（順番に出す演出用） */
  typingMessage?: Pick<TimelineMessage, 'role' | 'personaId'>;
  chatLoading: boolean;
  applyLoading: boolean;
  evaluateLoading: boolean;
  messages: TimelineMessage[];
}

const DISPOSITION_LABELS: Record<ReviewDisposition, string> = {
  fix: '直す',
  rebut_keep: '反論して残す',
  hold: '保留',
};

const createInitialLiveState = createInitialState;

const OWNER = ACTIVE_THEME.owner;

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
  liveAppState: createInitialLiveState(INITIAL_SPEC),
  selectedCohortId: undefined,
  decisions: [],
  interactionMode: 'play',
  penPoints: [],
  circledComponentIds: [],
  topicTargetIds: [],
  inputText: '',
  typingMessage: undefined,
  chatLoading: false,
  applyLoading: false,
  evaluateLoading: false,
  messages: [],
};

function getCurrentCheckpoint(): Checkpoint {
  return state.checkpoints[state.activeCheckpointIndex] ?? state.checkpoints[0];
}

function getCurrentSpec(): AppSpec {
  return getCurrentCheckpoint().spec;
}

function findPersona(personaId: string | undefined): ReviewerPersona | undefined {
  if (!personaId) return undefined;
  return getReviewersByCohort(state.selectedCohortId).find((p) => p.id === personaId);
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
  const parts = text
    .split(/\n+|(?<=[。！？!?])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  enqueueMessages(
    ACTIVE_THEME.introScript.map((line) => ({
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

function collectComponentRects(container: HTMLElement): Rect2D[] {
  const containerRect = container.getBoundingClientRect();
  const elements = querySandboxComponentElements(container);
  const rects: Rect2D[] = [];
  for (const el of elements) {
    const id = el.dataset.componentId;
    if (!id) continue;
    const r = el.getBoundingClientRect();
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
  };

  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);
}

function pushNewCheckpoint(commitMessage: string, updatedSpec: AppSpec): void {
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
  state.liveAppState = createInitialLiveState(updatedSpec);
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
  const cohort = TARGET_COHORTS.find((c) => c.id === cohortId) ?? TARGET_COHORTS[0];
  state.selectedCohortId = cohort.id;

  void recordDecision({
    stage: 'select_cohort',
    targetId: cohort.id,
    chosenLabel: cohort.label,
    reason: '',
    cohortId: cohort.id,
  });

  renderStudio();
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
  for (const persona of reviewers) {
    const sim = simulatePersonaComputerUse(currentSpec, persona);
    hearingQueue.push({
      message: { role: 'customer', personaId: persona.id, text: persona.greeting },
      typingMs: typingDurationFor(persona.greeting),
    });
    if (sim.outcome !== 'achieved') {
      abandonedCount++;
      hearingQueue.push({
        message: { role: 'customer', personaId: persona.id, text: sim.simulatedComment },
        typingMs: typingDurationFor(sim.simulatedComment),
      });
    }
  }

  const guideLines =
    abandonedCount > 0
      ? [
          '3人とも途中で買えずに帰ってしまっていますね…',
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
function buildChatHistory(): ChatHistoryEntry[] {
  return state.messages.slice(-12).map((m) => ({
    speaker:
      m.role === 'user'
        ? 'ユーザー'
        : m.role === 'assistant'
          ? 'お助けエージェント'
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
async function handleSendMessage(
  overrideText?: string,
  targetIdsOverride?: string[],
): Promise<void> {
  const text = (overrideText ?? state.inputText).trim();
  if (!text || state.chatLoading || state.applyLoading) return;
  flushMessageQueue();

  const spec = getCurrentSpec();
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

  pushMessage({ role: 'user', text, targetComponentIds: targetIdsSnapshot });
  if (overrideText === undefined) {
    state.inputText = '';
  }
  state.penPoints = [];
  state.circledComponentIds = [];
  state.chatLoading = true;
  renderStudio();
  scrollToLatestMessage();

  try {
    const data = await postJson<ChatResponse>('/api/chat', {
      currentSpec: spec,
      targetComponentIds: targetIdsSnapshot,
      userMessage: text,
      cohortId: state.selectedCohortId,
      annotatedImageBase64,
      history,
    });

    if (data.applied) {
      const applied = data.applied;
      if (applied.decisionRecord) {
        state.decisions.push(applied.decisionRecord);
      }
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
        pushNewCheckpoint(applied.commitMessage, applied.updatedSpec);
        pushMessage({
          role: 'assistant',
          text: applied.commitMessage,
          targetComponentIds: targetIdsSnapshot,
          showEvaluateAction: hasWorkingOrder,
        });

        if (applied.ownerReaction) {
          const ownerChunks = splitIntoChatChunks(applied.ownerReaction);
          state.chatLoading = false;
          enqueueMessages(
            ownerChunks.map((chunk) => ({
              message: { role: 'owner' as const, text: chunk },
              typingMs: typingDurationFor(chunk),
            })),
          );
          return;
        }
      }
    } else {
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
    pushMessage({ role: 'system', tone: 'warning', text: describeError(err) });
  } finally {
    state.chatLoading = false;
    renderStudio();
    scrollToLatestMessage();
  }
}

async function handleEvaluate(): Promise<void> {
  if (state.evaluateLoading) return;
  flushMessageQueue();
  state.evaluateLoading = true;
  renderStudio();
  scrollToLatestMessage();

  try {
    const activePersonas = getReviewersByCohort(state.selectedCohortId);
    const maxBlur = Math.max(...activePersonas.map((p) => p.constraints.blurPx));
    const minContrast = Math.min(...activePersonas.map((p) => p.constraints.contrast));

    const componentBounds = sandboxStageEl ? collectComponentRects(sandboxStageEl) : undefined;
    const screenshotBase64 = sandboxStageEl
      ? captureSandboxSnapshot(getCurrentSpec(), state.liveAppState, sandboxStageEl, null, {
          blurPx: maxBlur,
          contrast: minContrast,
        })
      : undefined;

    const evaluation = await postJson<EvaluationResponse>('/api/evaluate', {
      currentSpec: getCurrentSpec(),
      cohortId: state.selectedCohortId,
      screenshotBase64,
      componentBounds,
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
      for (const ownerLine of buildOwnerClosingLines(OWNER, evaluation.owner)) {
        queued.push({
          message: { role: 'owner', text: ownerLine },
          typingMs: typingDurationFor(ownerLine),
        });
      }
      for (const line of [
        'おつかれさまでした！これでお仕事完了です',
        'もっと別の直し方を試したくなったら、続けていつでも指示してくださいね',
      ]) {
        queued.push({
          message: { role: 'assistant', text: line },
          typingMs: typingDurationFor(line),
        });
      }
    } else {
      for (const line of [
        `3人中${achievedCount}人が満足して買えました`,
        'それぞれの反応への対応を決めて、直したい場所を指示してください',
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

function handleSaveDisposition(
  msg: TimelineMessage,
  persona: ReviewerPersona,
  disposition: ReviewDisposition,
  reasonText: string,
): void {
  if (!msg.review) return;
  const reason = reasonText.trim();
  msg.review.disposition = {
    reviewerId: persona.id,
    disposition,
    reason,
    decidedAt: new Date().toISOString(),
  };
  msg.review.draft = undefined;

  void recordDecision({
    stage: 'review_disposition',
    targetId: persona.id,
    chosenLabel: `${persona.name}:${DISPOSITION_LABELS[disposition]}`,
    reason,
    cohortId: state.selectedCohortId,
  });
  renderStudio();
}

function jumpToCheckpoint(index: number): void {
  if (index < 0 || index >= state.checkpoints.length) return;
  state.activeCheckpointIndex = index;
  const spec = getCurrentSpec();
  state.liveAppState = createInitialLiveState(spec);
  state.penPoints = [];
  state.circledComponentIds = [];
  state.topicTargetIds = [];
  renderStudio();
}

function createReasonRow(
  placeholder: string,
  value: string,
  onInput: (value: string) => void,
  buttonLabel: string,
  onSubmit: () => void,
  disabled = false,
): HTMLElement {
  const reasonRow = document.createElement('div');
  reasonRow.className = 'inline-reason-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-reason-input';
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-inline-decide';
  button.disabled = disabled;
  button.textContent = buttonLabel;
  button.addEventListener('click', onSubmit);

  reasonRow.append(input, button);
  return reasonRow;
}

function renderCohortSelector(): HTMLElement {
  const pillRow = document.createElement('div');
  pillRow.className = 'cohort-pill-row';
  for (const c of TARGET_COHORTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSelected = state.selectedCohortId === c.id;
    btn.className = `cohort-pill-btn ${isSelected ? 'is-selected' : ''}`;
    btn.disabled = state.selectedCohortId !== undefined;
    btn.textContent = c.label;
    btn.addEventListener('click', () => handleSelectCohort(c.id));
    pillRow.appendChild(btn);
  }
  return pillRow;
}

function renderDispositionControls(msg: TimelineMessage, persona: ReviewerPersona): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'disposition-wrap';
  const review = msg.review!;

  if (review.disposition) {
    const saved = document.createElement('div');
    saved.className = 'decision-recorded-line';
    const label = DISPOSITION_LABELS[review.disposition.disposition];
    saved.textContent = review.disposition.reason ? `${label} ${review.disposition.reason}` : label;
    wrap.appendChild(saved);
    return wrap;
  }

  const dispBar = document.createElement('div');
  dispBar.className = 'disposition-choice-row';
  for (const key of Object.keys(DISPOSITION_LABELS) as ReviewDisposition[]) {
    const dBtn = document.createElement('button');
    dBtn.type = 'button';
    dBtn.className = `btn-disposition-pill ${review.draft?.disposition === key ? 'is-active' : ''}`;
    dBtn.textContent = DISPOSITION_LABELS[key];
    dBtn.addEventListener('click', () => {
      review.draft = { disposition: key, reason: review.draft?.reason ?? '' };
      renderStudio();
    });
    dispBar.appendChild(dBtn);
  }
  wrap.appendChild(dispBar);

  const draft = review.draft;
  if (draft) {
    wrap.appendChild(
      createReasonRow(
        '理由があれば',
        draft.reason,
        (v) => {
          draft.reason = v;
        },
        '決定',
        () => handleSaveDisposition(msg, persona, draft.disposition, draft.reason),
      ),
    );
  }
  return wrap;
}

const AGENT_NAME = 'お助けエージェント';
const AGENT_ICON = '助';

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
 * アイコンと名前つきの発言行（お客さん・お助けエージェント共通）
 * extras は吹き出しの下（アイコンの右側の列）に並べる要素
 */
function createSpeakerRow(
  kind: 'customer' | 'agent' | 'owner',
  icon: string,
  name: string,
  bubble: HTMLElement,
  extras: HTMLElement[] = [],
  isContinuation = false,
): HTMLElement {
  const row = document.createElement('div');
  row.className = `chat-bubble-row is-speaker is-${kind}${isContinuation ? ' is-continuation' : ''}`;

  const avatar = document.createElement('span');
  avatar.className = `speaker-avatar is-${kind}${isContinuation ? ' is-continuation' : ''}`;
  avatar.textContent = icon;

  const body = document.createElement('div');
  body.className = 'speaker-body';
  if (!isContinuation) {
    const nameEl = document.createElement('div');
    nameEl.className = 'speaker-name';
    nameEl.textContent = name;
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
  stream.className = 'vibe-chat-stream';
  chatScrollEl = stream;

  const lastAssistantMessageId = [...state.messages]
    .reverse()
    .find((m) => m.role === 'assistant')?.id;
  const isBusy = state.chatLoading || state.applyLoading || state.evaluateLoading;
  let prevSpeakerKey = '';

  for (const msg of state.messages) {
    const isFirstSeen = !seenMessageIds.has(msg.id);
    seenMessageIds.add(msg.id);
    const enteringClass = isFirstSeen ? ' is-entering' : '';
    const currentSpeakerKey = speakerKeyOf(msg);
    const isContinuation = currentSpeakerKey === prevSpeakerKey;
    prevSpeakerKey = currentSpeakerKey;

    // 進行役のアナウンス：吹き出しなしで中央に小さく出す
    if (msg.role === 'system') {
      const row = document.createElement('div');
      row.className = `chat-system-row${enteringClass}`;
      const line = document.createElement('div');
      line.className = `chat-system-line ${msg.tone === 'warning' ? 'is-warning' : ''}`;
      line.textContent = msg.text;
      row.appendChild(line);
      if (msg.showCohortSelector) {
        row.appendChild(renderCohortSelector());
      }
      stream.appendChild(row);
      continue;
    }

    // お客さんの発言：アイコンと名前つきの吹き出し
    if (msg.role === 'customer') {
      const persona = findPersona(msg.personaId);
      const outcomeClass = msg.review ? ` is-${msg.review.outcome}` : '';
      const bubble = createBubble(`chat-bubble is-customer${outcomeClass}${enteringClass}`, msg.text);
      if (msg.review && persona) {
        bubble.appendChild(renderDispositionControls(msg, persona));
      }
      stream.appendChild(
        createSpeakerRow('customer', persona?.icon ?? '', persona?.name ?? '', bubble, [], isContinuation),
      );
      continue;
    }

    // 店長の発言
    if (msg.role === 'owner') {
      const bubble = createBubble(`chat-bubble is-owner${enteringClass}`, msg.text);
      stream.appendChild(createSpeakerRow('owner', OWNER.icon, OWNER.name, bubble, [], isContinuation));
      continue;
    }

    // お助けエージェントの発言：進行案内・質問回答・改造完了の報告
    if (msg.role === 'assistant') {
      const bubble = createBubble(`chat-bubble is-agent${enteringClass}`, msg.text);
      const extras: HTMLElement[] = [];
      if (msg.id === lastAssistantMessageId && !isBusy) {
        if (
          (msg.followUps && msg.followUps.length > 0) ||
          (msg.showEvaluateAction && !getCurrentCheckpoint().evaluation)
        ) {
          const chipRow = document.createElement('div');
          chipRow.className = 'followup-chip-row';
          if (msg.showEvaluateAction && !getCurrentCheckpoint().evaluation) {
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
        createSpeakerRow('agent', AGENT_ICON, AGENT_NAME, bubble, extras, isContinuation),
      );
      continue;
    }

    // 学習者の発言
    const row = document.createElement('div');
    row.className = 'chat-bubble-row is-user';
    row.appendChild(createBubble(`chat-bubble is-user${enteringClass}`, msg.text));
    stream.appendChild(row);
  }

  // 店長の書き込み中の表示
  if (state.typingMessage?.role === 'owner') {
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
  if (state.typingMessage?.role === 'customer') {
    const persona = findPersona(state.typingMessage.personaId);
    stream.appendChild(
      createSpeakerRow(
        'customer',
        persona?.icon ?? '',
        persona?.name ?? '',
        createTypingBubble('chat-bubble is-customer is-loading', `${persona?.name ?? ''}が書き込み中`),
        [],
        prevSpeakerKey === `customer:${state.typingMessage.personaId ?? ''}`,
      ),
    );
  }

  // お助けエージェントの書き込み中の表示（演出キューまたはAI応答待ち）
  if (state.typingMessage?.role === 'assistant' || state.chatLoading) {
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

  // 改修中・反応確認中は状況を表示する
  if (state.applyLoading || state.evaluateLoading) {
    const row = document.createElement('div');
    row.className = 'chat-system-row';
    const line = document.createElement('div');
    line.className = 'chat-system-line is-progress';
    line.innerHTML = `
      <span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      <span>${state.evaluateLoading ? 'お客さんが画面を操作しています' : '改造しています'}</span>
    `;
    row.appendChild(line);
    stream.appendChild(row);
  }

  chatCard.appendChild(stream);

  const composer = document.createElement('div');
  composer.className = 'vibe-composer';

  const formRow = document.createElement('form');
  formRow.className = 'composer-form-row';
  formRow.addEventListener('submit', (e) => {
    e.preventDefault();
    void handleSendMessage();
  });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'composer-input';
  input.placeholder = '質問や改造の指示を入力（例：注文ボタンを動くように直して）';
  input.value = state.inputText;
  input.addEventListener('input', () => {
    state.inputText = input.value;
    sendBtn.disabled = state.chatLoading || state.applyLoading || !state.inputText.trim();
  });

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'btn-composer-send';
  sendBtn.disabled = state.chatLoading || state.applyLoading || !state.inputText.trim();
  sendBtn.textContent = '送信';

  formRow.append(input, sendBtn);
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
          pill.textContent = idx === 0 ? '最初' : `改造${cp.stepNumber}`;
          pill.addEventListener('click', () => jumpToCheckpoint(idx));
          cpBar.appendChild(pill);
        });
        header.appendChild(cpBar);
      }

      if (state.selectedCohortId) {
        const cohort = TARGET_COHORTS.find((c) => c.id === state.selectedCohortId);
        const evalRes = getCurrentCheckpoint().evaluation;
        const goalBadge = document.createElement('div');
        goalBadge.className = 'goal-status-bar';
        if (evalRes) {
          const achieved = evalRes.results.filter((r) => r.outcome === 'achieved').length;
          goalBadge.textContent = `目標 ${cohort?.label ?? ''} 3人全員が満足して注文できること（現在 ${achieved}/3人 達成）`;
        } else {
          goalBadge.textContent = `目標 ${cohort?.label ?? ''} 3人全員が満足して注文できる画面に改造する`;
        }
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
      state.checkpoints.length > 1 && !getCurrentCheckpoint().evaluation;
    const evalBtn = document.createElement('button');
    evalBtn.type = 'button';
    evalBtn.className = `btn-bottom-evaluate ${hasUnevaluatedChanges ? 'is-ready' : ''}`;
    evalBtn.disabled = state.evaluateLoading;
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
