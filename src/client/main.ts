import { detectHitComponents, type Point2D, type Rect2D } from '../shared/hitTest.ts';
import {
  getReviewersByCohort,
  INITIAL_ALARM_SPEC,
  TARGET_COHORTS,
} from '../shared/initialTheme.ts';
import { escapeHtml } from '../shared/sandboxValidator.ts';
import type {
  ApplyResponse,
  AppSpec,
  ChatResponse,
  Checkpoint,
  EvaluationResponse,
  HumanDecisionRecord,
  InspectedComponentInfo,
  RecordDecisionResponse,
  ReviewDisposition,
  ReviewerDispositionRecord,
  StateValue,
  TargetCohortId,
  TradeoffOption,
} from '../shared/types.ts';
import { ICONS } from './icons.ts';
import {
  querySandboxComponentElements,
  renderSandboxApp,
  speakTextWithTts,
} from './sandboxRenderer.ts';
import { captureSandboxSnapshot } from './snapshot.ts';

interface TimelineMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  targetLabels?: string[];
  showCohortSelector?: boolean;
  cohortIntro?: TargetCohortId;
  intent?: 'explain' | 'direct_apply' | 'tradeoff_propose';
  inspectedComponents?: InspectedComponentInfo[];
  appliedSummary?: {
    commitMessage: string;
    changeHighlights: string[];
    rolledBack?: boolean;
  };
  options?: TradeoffOption[];
  draftOptionId?: string;
  draftOptionReason?: string;
  appliedOptionId?: string;
  appliedOptionReason?: string;
  evaluationResult?: EvaluationResponse;
  dispositions?: Record<string, ReviewerDispositionRecord>;
  draftDispositionByReviewer?: Record<
    string,
    { disposition: ReviewDisposition; reason: string }
  >;
}

interface StudioState {
  checkpoints: Checkpoint[];
  activeCheckpointIndex: number;
  liveAppState: Record<string, StateValue>;
  selectedCohortId?: TargetCohortId;
  draftCohortId: TargetCohortId;
  draftCohortReason: string;
  cohortReason: string;
  decisions: HumanDecisionRecord[];
  interactionMode: 'play' | 'pen';
  penPoints: Point2D[];
  circledComponentIds: string[];
  inputText: string;
  introTyping: boolean;
  chatLoading: boolean;
  applyLoading: boolean;
  evaluateLoading: boolean;
  messages: TimelineMessage[];
}

function createInitialLiveState(spec: AppSpec): Record<string, StateValue> {
  const map: Record<string, StateValue> = {};
  for (const s of spec.state) {
    map[s.key] = s.initialValue;
  }
  return map;
}

const INITIAL_WELCOME_STEPS: Array<{ text: string; showCohortSelector?: boolean }> = [
  { text: 'この目覚まし時計、実はあちこち壊れてるんだ' },
  { text: 'まずは左のスマホを触ってみて' },
  {
    text: '誰のために改造するか、顧客層を選んで理由を一言書いてね',
    showCohortSelector: true,
  },
];

const state: StudioState = {
  checkpoints: [
    {
      id: 'cp-0',
      stepNumber: 0,
      commitMessage: 'かいぞう前',
      changeHighlights: ['初期状態'],
      createdAt: new Date().toISOString(),
      spec: structuredClone(INITIAL_ALARM_SPEC),
    },
  ],
  activeCheckpointIndex: 0,
  liveAppState: createInitialLiveState(INITIAL_ALARM_SPEC),
  selectedCohortId: undefined,
  draftCohortId: 'elderly',
  draftCohortReason: '',
  cohortReason: '',
  decisions: [],
  interactionMode: 'play',
  penPoints: [],
  circledComponentIds: [],
  inputText: '',
  introTyping: true,
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
let toastTimer: number | null = null;
const introTimers: number[] = [];
const seenMessageIds = new Set<string>();

function stopIntroSequence(): void {
  while (introTimers.length > 0) {
    const id = introTimers.pop();
    if (id !== undefined) {
      window.clearTimeout(id);
    }
  }
  state.introTyping = false;
}

function playInitialWelcomeSequence(): void {
  state.introTyping = true;
  renderStudio();

  const delays = [450, 1050, 1700];
  INITIAL_WELCOME_STEPS.forEach((step, idx) => {
    const timerId = window.setTimeout(() => {
      state.messages.push({
        id: `msg-welcome-${idx}`,
        role: 'assistant',
        text: step.text,
        showCohortSelector: step.showCohortSelector,
      });
      if (idx === INITIAL_WELCOME_STEPS.length - 1) {
        state.introTyping = false;
      }
      renderStudio();
      scrollToLatestMessage();
    }, delays[idx] ?? (idx + 1) * 600);
    introTimers.push(timerId);
  });
}

function scrollToLatestMessage(): void {
  window.requestAnimationFrame(() => {
    if (chatScrollEl) {
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
    }
  });
}

function showSandboxToast(message: string, type: 'info' | 'success' | 'warning'): void {
  if (!sandboxStageEl) return;
  const existing = sandboxStageEl.querySelector('.sandbox-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `sandbox-toast toast-${type}`;
  toast.textContent = message;
  sandboxStageEl.appendChild(toast);

  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toast.remove();
  }, 2600);
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

function pushNewCheckpoint(
  commitMessage: string,
  changeHighlights: string[],
  updatedSpec: AppSpec,
): void {
  const nextStepNumber = state.checkpoints.length;
  const newCheckpoint: Checkpoint = {
    id: `cp-${nextStepNumber}-${Date.now()}`,
    stepNumber: nextStepNumber,
    commitMessage,
    changeHighlights,
    createdAt: new Date().toISOString(),
    spec: updatedSpec,
  };

  state.checkpoints.push(newCheckpoint);
  state.activeCheckpointIndex = state.checkpoints.length - 1;
  state.liveAppState = createInitialLiveState(updatedSpec);
  state.penPoints = [];
  state.circledComponentIds = [];
  state.interactionMode = 'play';
}

async function handleConfirmCohort(): Promise<void> {
  const cohort = TARGET_COHORTS.find((c) => c.id === state.draftCohortId) ?? TARGET_COHORTS[0];
  const reason = state.draftCohortReason.trim() || `${cohort.label}が一番困っていそうだから`;
  state.selectedCohortId = cohort.id;
  state.cohortReason = reason;

  try {
    const res = await fetch('/api/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: 'select_cohort',
        targetId: cohort.id,
        chosenLabel: cohort.label,
        reason,
        cohortId: cohort.id,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as RecordDecisionResponse;
      state.decisions.push(data.decision);
    }
  } catch {
    // 通信失敗時もローカル進行を継続
  }

  state.messages.push({
    id: `cohort-intro-${Date.now()}`,
    role: 'assistant',
    text: `${cohort.label}の3人がやって来たよ。赤ペンで気になるところを囲んで話しかけてね。`,
    cohortIntro: cohort.id,
  });
  renderStudio();
  scrollToLatestMessage();
}

async function handleSendMessage(overrideText?: string): Promise<void> {
  const text = (overrideText ?? state.inputText).trim();
  if (!text || state.chatLoading || state.applyLoading) return;
  stopIntroSequence();

  const spec = getCurrentSpec();
  const targetComponents = spec.components.filter((c) => state.circledComponentIds.includes(c.id));
  const targetLabels = targetComponents.map((c) => c.label);
  const targetIdsSnapshot = [...state.circledComponentIds];

  state.messages.push({
    id: `user-${Date.now()}`,
    role: 'user',
    text,
    targetLabels,
  });
  state.inputText = '';
  state.chatLoading = true;
  renderStudio();
  scrollToLatestMessage();

  try {
    const hasPenAnnotation = targetIdsSnapshot.length > 0 || state.penPoints.length > 0;
    const annotatedImageBase64 =
      hasPenAnnotation && sandboxStageEl
        ? captureSandboxSnapshot(spec, state.liveAppState, sandboxStageEl, penCanvasEl)
        : undefined;

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentSpec: spec,
        targetComponentIds: targetIdsSnapshot,
        userMessage: text,
        cohortId: state.selectedCohortId,
        annotatedImageBase64,
      }),
    });

    if (!res.ok) {
      throw new Error('通信エラーが発生しました');
    }

    const data = (await res.json()) as ChatResponse;

    if (data.intent === 'direct_apply' && data.appliedResult) {
      if (!data.appliedResult.rolledBack) {
        pushNewCheckpoint(
          data.appliedResult.commitMessage,
          data.appliedResult.changeHighlights,
          data.appliedResult.updatedSpec,
        );
        showSandboxToast('スマホ画面を改造しました', 'success');
      } else {
        showSandboxToast('検証エラーのため直前の版へ戻しました', 'warning');
      }
    }

    state.messages.push({
      id: `ai-${Date.now()}`,
      role: 'assistant',
      text: data.reply,
      intent: data.intent,
      inspectedComponents: data.inspectedComponents,
      appliedSummary: data.appliedResult
        ? {
            commitMessage: data.appliedResult.commitMessage,
            changeHighlights: data.appliedResult.changeHighlights,
            rolledBack: data.appliedResult.rolledBack,
          }
        : undefined,
      options: data.options,
    });
  } catch (err) {
    state.messages.push({
      id: `err-${Date.now()}`,
      role: 'assistant',
      text: err instanceof Error ? `エラーが起きました: ${err.message}` : '通信に失敗しました。',
    });
  } finally {
    state.chatLoading = false;
    renderStudio();
    scrollToLatestMessage();
  }
}

async function handleSelectStrategyOption(
  msg: TimelineMessage,
  option: TradeoffOption,
  reasonText: string,
): Promise<void> {
  if (state.applyLoading || state.chatLoading) return;
  stopIntroSequence();
  const reason = reasonText.trim() || `${option.pros}を優先したいから`;
  state.applyLoading = true;
  msg.appliedOptionId = option.id;
  msg.appliedOptionReason = reason;
  renderStudio();

  try {
    const spec = getCurrentSpec();
    const res = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentSpec: spec,
        targetComponentIds: state.circledComponentIds,
        userInstruction: option.title,
        selectedOption: option,
        selectionReason: reason,
        cohortId: state.selectedCohortId,
      }),
    });

    if (!res.ok) {
      throw new Error('通信エラーが発生しました');
    }
    const data = (await res.json()) as ApplyResponse;
    if (data.decisionRecord) {
      state.decisions.push(data.decisionRecord);
    }

    if (!data.rolledBack) {
      pushNewCheckpoint(data.commitMessage, data.changeHighlights, data.updatedSpec);
      showSandboxToast('作戦どおりに改造しました', 'success');
    } else {
      showSandboxToast('検証エラーのため直前の版へ戻しました', 'warning');
    }

    state.messages.push({
      id: `ai-apply-${Date.now()}`,
      role: 'assistant',
      text: data.rolledBack
        ? '改修コードの検証で問題が見つかったため、直前の版に自動ロールバックしたよ。'
        : `${option.title}で改造したよ。左のスマホを触るか、採点するボタンでお客さんの反応を見てみよう。`,
      intent: 'direct_apply',
      appliedSummary: {
        commitMessage: data.commitMessage,
        changeHighlights: data.changeHighlights,
        rolledBack: data.rolledBack,
      },
    });
  } catch (err) {
    showSandboxToast(
      err instanceof Error ? `エラー: ${err.message}` : '改造に失敗しました',
      'warning',
    );
  } finally {
    state.applyLoading = false;
    renderStudio();
    scrollToLatestMessage();
  }
}

async function handleEvaluate(): Promise<void> {
  if (state.evaluateLoading) return;
  stopIntroSequence();
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

    const res = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentSpec: getCurrentSpec(),
        cohortId: state.selectedCohortId,
        screenshotBase64,
        componentBounds,
      }),
    });

    if (!res.ok) {
      throw new Error('通信エラーが発生しました');
    }
    const evaluation = (await res.json()) as EvaluationResponse;
    getCurrentCheckpoint().evaluation = evaluation;

    const achievedCount = evaluation.results.filter((r) => r.outcome === 'achieved').length;
    state.messages.push({
      id: `eval-${Date.now()}`,
      role: 'assistant',
      text:
        achievedCount === activePersonas.length
          ? `採点結果：${achievedCount} / ${activePersonas.length} 人クリア。それぞれの感想に対して直すか残すか決めよう。`
          : `採点結果：${achievedCount} / ${activePersonas.length} 人クリア。3人が実際に操作した感想に採否をつけよう。`,
      evaluationResult: evaluation,
      dispositions: {},
      draftDispositionByReviewer: {},
    });

    // 1人目の感想をペルソナの声(TTS)で自動読み上げ
    const firstResult = evaluation.results[0];
    const firstPersona = activePersonas.find((p) => p.id === firstResult?.reviewerId);
    if (firstResult && firstPersona) {
      speakTextWithTts(firstResult.comment, {
        pitch: firstPersona.constraints.voicePitch,
        rate: firstPersona.constraints.voiceRate,
      });
    }
  } catch (err) {
    showSandboxToast(
      err instanceof Error ? `エラー: ${err.message}` : '採点に失敗しました',
      'warning',
    );
  } finally {
    state.evaluateLoading = false;
    renderStudio();
    scrollToLatestMessage();
  }
}

async function handleSaveDisposition(
  msg: TimelineMessage,
  reviewerId: string,
  reviewerName: string,
  disposition: ReviewDisposition,
  reasonText: string,
): Promise<void> {
  const dispositionLabel =
    disposition === 'fix' ? '直す' : disposition === 'rebut_keep' ? '反論して残す' : '保留';
  const reason =
    reasonText.trim() ||
    (disposition === 'fix'
      ? '優先して改善したいから'
      : disposition === 'rebut_keep'
        ? '今の仕様のメリットを残したいから'
        : 'あとで検討するから');

  if (!msg.dispositions) {
    msg.dispositions = {};
  }
  msg.dispositions[reviewerId] = {
    reviewerId,
    disposition,
    reason,
    decidedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch('/api/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: 'review_disposition',
        targetId: reviewerId,
        chosenLabel: `${reviewerName}:${dispositionLabel}`,
        reason,
        cohortId: state.selectedCohortId,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as RecordDecisionResponse;
      state.decisions.push(data.decision);
    }
  } catch {
    // 通信失敗時も画面表示を更新
  }

  renderStudio();
}

function jumpToCheckpoint(index: number): void {
  if (index < 0 || index >= state.checkpoints.length) return;
  state.activeCheckpointIndex = index;
  const spec = getCurrentSpec();
  state.liveAppState = createInitialLiveState(spec);
  state.penPoints = [];
  state.circledComponentIds = [];
  renderStudio();
}

function renderChatPanel(spec: AppSpec): HTMLElement {
  const chatCard = document.createElement('section');
  chatCard.className = 'vibe-chat-card';

  const stream = document.createElement('div');
  stream.className = 'vibe-chat-stream';
  chatScrollEl = stream;

  for (const msg of state.messages) {
    const row = document.createElement('div');
    row.className = `chat-bubble-row is-${msg.role}`;

    const isFirstSeen = !seenMessageIds.has(msg.id);
    seenMessageIds.add(msg.id);

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble is-${msg.role}${isFirstSeen ? ' is-entering' : ''}`;

    if (msg.targetLabels && msg.targetLabels.length > 0) {
      const tagRow = document.createElement('div');
      tagRow.className = 'bubble-target-tags';
      for (const lbl of msg.targetLabels) {
        const t = document.createElement('span');
        t.className = 'bubble-target-pill';
        t.textContent = `対象：${lbl}`;
        tagRow.appendChild(t);
      }
      bubble.appendChild(tagRow);
    }

    const bodyText = document.createElement('div');
    bodyText.className = 'bubble-text';
    bodyText.textContent = msg.text;
    bubble.appendChild(bodyText);

    // 体験ステップ1：顧客層を選ぶカード
    if (msg.showCohortSelector) {
      const cohortBox = document.createElement('div');
      cohortBox.className = 'cohort-selector-box';

      const pillRow = document.createElement('div');
      pillRow.className = 'cohort-pill-row';
      for (const c of TARGET_COHORTS) {
        const activeId = state.selectedCohortId ?? state.draftCohortId;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `cohort-pill-btn ${activeId === c.id ? 'is-selected' : ''}`;
        btn.innerHTML = `<strong>${escapeHtml(c.label)}</strong><span>${escapeHtml(c.shortDesc)}</span>`;
        btn.addEventListener('click', () => {
          state.draftCohortId = c.id;
          if (state.selectedCohortId) {
            state.selectedCohortId = undefined;
          }
          renderStudio();
        });
        pillRow.appendChild(btn);
      }
      cohortBox.appendChild(pillRow);

      if (state.selectedCohortId) {
        const chosenCohort = TARGET_COHORTS.find((c) => c.id === state.selectedCohortId);
        const doneLine = document.createElement('div');
        doneLine.className = 'decision-recorded-line';
        doneLine.textContent = `決定：${chosenCohort?.label ?? ''} ／ 理由：${state.cohortReason}`;
        cohortBox.appendChild(doneLine);
      } else {
        const reasonRow = document.createElement('div');
        reasonRow.className = 'inline-reason-row';
        const reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.className = 'inline-reason-input';
        reasonInput.placeholder = '選んだ理由を一言で入力';
        reasonInput.value = state.draftCohortReason;
        reasonInput.addEventListener('input', () => {
          state.draftCohortReason = reasonInput.value;
        });

        const decideBtn = document.createElement('button');
        decideBtn.type = 'button';
        decideBtn.className = 'btn-inline-decide';
        decideBtn.textContent = '決定';
        decideBtn.addEventListener('click', () => {
          void handleConfirmCohort();
        });

        reasonRow.append(reasonInput, decideBtn);
        cohortBox.appendChild(reasonRow);
      }

      bubble.appendChild(cohortBox);
    }

    // 選んだ顧客層の3人紹介カード
    if (msg.cohortIntro) {
      const personas = getReviewersByCohort(msg.cohortIntro);
      const introList = document.createElement('div');
      introList.className = 'cohort-persona-preview';
      for (const p of personas) {
        const chip = document.createElement('div');
        chip.className = 'cohort-persona-chip';
        chip.innerHTML = `
          <span class="customer-mini-avatar">${escapeHtml(p.icon)}</span>
          <strong>${escapeHtml(p.name)}</strong>
          <span class="persona-trait-tag">${escapeHtml(p.traitLabel)}</span>
          <small>${escapeHtml(p.goal)}</small>
        `;
        introList.appendChild(chip);
      }
      bubble.appendChild(introList);
    }

    // 質問時のしくみカード
    if (msg.inspectedComponents && msg.inspectedComponents.length > 0) {
      const inspectList = document.createElement('div');
      inspectList.className = 'inspect-card-list';
      for (const info of msg.inspectedComponents) {
        const ic = document.createElement('div');
        ic.className = 'inspect-info-card';
        ic.innerHTML = `
          <div class="inspect-info-title">${escapeHtml(info.label)} のしくみ</div>
          <div class="inspect-info-how">${escapeHtml(info.howItWorks)}</div>
          <div class="inspect-info-hint">${escapeHtml(info.issueOrHint)}</div>
        `;
        inspectList.appendChild(ic);
      }
      bubble.appendChild(inspectList);
    }

    // 改造完了またはロールバック時の変更点リスト
    if (msg.appliedSummary) {
      const summaryBox = document.createElement('div');
      summaryBox.className = `applied-summary-box ${msg.appliedSummary.rolledBack ? 'is-rollback' : ''}`;
      for (const h of msg.appliedSummary.changeHighlights) {
        const line = document.createElement('div');
        line.textContent = `・${h}`;
        summaryBox.appendChild(line);
      }
      bubble.appendChild(summaryBox);
    }

    // 体験ステップ3：トレードオフ作戦カード ＋ 理由の記録
    if (msg.options && msg.options.length > 0) {
      const deck = document.createElement('div');
      deck.className = 'inline-choice-deck';
      msg.options.forEach((opt, idx) => {
        const letter = ['A', 'B', 'C'][idx] ?? String(idx + 1);
        const isPicked = msg.appliedOptionId === opt.id;
        const isDraft = msg.draftOptionId === opt.id && !msg.appliedOptionId;

        const cardWrap = document.createElement('div');
        cardWrap.className = `inline-choice-card ${isPicked ? 'is-picked' : ''} ${isDraft ? 'is-draft' : ''}`;

        const headBtn = document.createElement('button');
        headBtn.type = 'button';
        headBtn.className = 'inline-choice-trigger';
        headBtn.disabled = state.applyLoading;
        headBtn.innerHTML = `
          <div class="inline-choice-head">
            <span class="choice-letter">${escapeHtml(letter)}</span>
            <span class="choice-title">${escapeHtml(opt.title.replace(/^案[ABC][：:]?/, ''))}</span>
            <span class="inline-choice-cta">${isPicked ? '適用済み' : '選ぶ'}</span>
          </div>
          <div class="choice-tradeoff-rows">
            <div class="tradeoff-line is-plus"><span class="tradeoff-badge">プラス</span><span>${escapeHtml(opt.pros)}</span></div>
            <div class="tradeoff-line is-minus"><span class="tradeoff-badge">マイナス</span><span>${escapeHtml(opt.tradeoff)}</span></div>
          </div>
        `;
        headBtn.addEventListener('click', () => {
          msg.draftOptionId = opt.id;
          renderStudio();
        });
        cardWrap.appendChild(headBtn);

        if (isDraft) {
          const reasonRow = document.createElement('div');
          reasonRow.className = 'inline-reason-row';
          const rInput = document.createElement('input');
          rInput.type = 'text';
          rInput.className = 'inline-reason-input';
          rInput.placeholder = 'この作戦を選んだ理由を一言入力';
          rInput.value = msg.draftOptionReason ?? '';
          rInput.addEventListener('input', () => {
            msg.draftOptionReason = rInput.value;
          });

          const applyBtn = document.createElement('button');
          applyBtn.type = 'button';
          applyBtn.className = 'btn-inline-decide';
          applyBtn.disabled = state.applyLoading;
          applyBtn.textContent = '改造する';
          applyBtn.addEventListener('click', () => {
            void handleSelectStrategyOption(msg, opt, msg.draftOptionReason ?? '');
          });

          reasonRow.append(rInput, applyBtn);
          cardWrap.appendChild(reasonRow);
        }

        if (isPicked && msg.appliedOptionReason) {
          const reasonNote = document.createElement('div');
          reasonNote.className = 'decision-recorded-line';
          reasonNote.textContent = `判断理由：${msg.appliedOptionReason}`;
          cardWrap.appendChild(reasonNote);
        }

        deck.appendChild(cardWrap);
      });
      bubble.appendChild(deck);
    }

    // 体験ステップ5＆6：Computer Use レビュー結果 ＋ TTS読み上げ ＋ 採否決定（直す／反論して残す／保留）
    if (msg.evaluationResult) {
      const evalCohortPersonas = getReviewersByCohort(
        msg.evaluationResult.cohortId ?? state.selectedCohortId,
      );
      const reviewList = document.createElement('div');
      reviewList.className = 'chat-review-list';

      for (const persona of evalCohortPersonas) {
        const res = msg.evaluationResult.results.find((r) => r.reviewerId === persona.id);
        const ok = res?.outcome === 'achieved';
        const item = document.createElement('div');
        item.className = `customer-mini-card ${ok ? 'is-achieved' : 'is-abandoned'}`;

        const topRow = document.createElement('div');
        topRow.className = 'customer-mini-top';
        topRow.innerHTML = `
          <span class="customer-mini-who">
            <span class="customer-mini-avatar">${escapeHtml(persona.icon)}</span>
            <strong>${escapeHtml(persona.name)}</strong>
            <span class="persona-trait-tag">${escapeHtml(persona.traitLabel)}</span>
          </span>
        `;

        const rightControls = document.createElement('div');
        rightControls.className = 'customer-mini-controls';

        const ttsBtn = document.createElement('button');
        ttsBtn.type = 'button';
        ttsBtn.className = 'btn-persona-tts';
        ttsBtn.innerHTML = `${ICONS.volume}<span>声</span>`;
        ttsBtn.addEventListener('click', () => {
          speakTextWithTts(res?.comment ?? '', {
            pitch: persona.constraints.voicePitch,
            rate: persona.constraints.voiceRate,
          });
        });

        const stamp = document.createElement('span');
        stamp.className = `stamp-badge ${ok ? 'achieved' : 'abandoned'}`;
        stamp.textContent = ok ? 'クリア' : 'ギブアップ';

        rightControls.append(ttsBtn, stamp);
        topRow.appendChild(rightControls);
        item.appendChild(topRow);

        if (res?.actionTrace && res.actionTrace.length > 0) {
          const traceLine = document.createElement('div');
          traceLine.className = 'customer-action-trace';
          traceLine.textContent = res.actionTrace[res.actionTrace.length - 1];
          item.appendChild(traceLine);
        }

        const commentEl = document.createElement('div');
        commentEl.className = 'customer-mini-comment';
        commentEl.textContent = res?.comment ?? '';
        item.appendChild(commentEl);

        // 体験ステップ6：指摘ごとに「直す／反論して残す／保留」を理由付きで選ぶ
        const savedDisp = msg.dispositions?.[persona.id];
        if (savedDisp) {
          const dispLabel =
            savedDisp.disposition === 'fix'
              ? '直す'
              : savedDisp.disposition === 'rebut_keep'
                ? '反論して残す'
                : '保留';
          const savedEl = document.createElement('div');
          savedEl.className = 'decision-recorded-line';
          savedEl.textContent = `採否：${dispLabel} ／ 理由：${savedDisp.reason}`;
          item.appendChild(savedEl);
        } else {
          if (!msg.draftDispositionByReviewer) {
            msg.draftDispositionByReviewer = {};
          }
          const draft = msg.draftDispositionByReviewer[persona.id];

          const dispBar = document.createElement('div');
          dispBar.className = 'disposition-choice-row';
          const choices: Array<{ key: ReviewDisposition; label: string }> = [
            { key: 'fix', label: '直す' },
            { key: 'rebut_keep', label: '反論して残す' },
            { key: 'hold', label: '保留' },
          ];

          for (const ch of choices) {
            const dBtn = document.createElement('button');
            dBtn.type = 'button';
            dBtn.className = `btn-disposition-pill ${draft?.disposition === ch.key ? 'is-active' : ''}`;
            dBtn.textContent = ch.label;
            dBtn.addEventListener('click', () => {
              msg.draftDispositionByReviewer![persona.id] = {
                disposition: ch.key,
                reason: draft?.reason ?? '',
              };
              renderStudio();
            });
            dispBar.appendChild(dBtn);
          }
          item.appendChild(dispBar);

          if (draft) {
            const reasonRow = document.createElement('div');
            reasonRow.className = 'inline-reason-row';
            const rInput = document.createElement('input');
            rInput.type = 'text';
            rInput.className = 'inline-reason-input';
            rInput.placeholder = '採否の理由を一言入力';
            rInput.value = draft.reason;
            rInput.addEventListener('input', () => {
              draft.reason = rInput.value;
            });

            const saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'btn-inline-decide';
            saveBtn.textContent = '記録';
            saveBtn.addEventListener('click', () => {
              void handleSaveDisposition(
                msg,
                persona.id,
                persona.name,
                draft.disposition,
                draft.reason,
              );
            });

            reasonRow.append(rInput, saveBtn);
            item.appendChild(reasonRow);
          }
        }

        reviewList.appendChild(item);
      }
      bubble.appendChild(reviewList);
    }

    row.appendChild(bubble);
    stream.appendChild(row);
  }

  if (state.introTyping || state.chatLoading || state.applyLoading || state.evaluateLoading) {
    const loadingRow = document.createElement('div');
    loadingRow.className = 'chat-bubble-row is-assistant';
    const statusText = state.evaluateLoading
      ? 'お客さん3人が時計を操作しています'
      : state.applyLoading
        ? '改造コードを検証して反映しています'
        : state.chatLoading
          ? '考えています'
          : '';
    loadingRow.innerHTML = `
      <div class="chat-bubble is-assistant is-loading" aria-label="入力中">
        <span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
        ${statusText ? `<span class="loading-status-text">${statusText}</span>` : ''}
      </div>
    `;
    stream.appendChild(loadingRow);
  }

  chatCard.appendChild(stream);

  const composer = document.createElement('div');
  composer.className = 'vibe-composer';

  const circledComponents = spec.components.filter((c) => state.circledComponentIds.includes(c.id));
  if (circledComponents.length > 0) {
    const selectionBar = document.createElement('div');
    selectionBar.className = 'composer-selection-bar';
    for (const c of circledComponents) {
      const badge = document.createElement('span');
      badge.className = 'target-tag';
      badge.textContent = `選択中：${c.label}`;
      selectionBar.appendChild(badge);
    }
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn-text-link';
    clearBtn.textContent = '解除';
    clearBtn.addEventListener('click', () => {
      state.penPoints = [];
      state.circledComponentIds = [];
      renderStudio();
    });
    selectionBar.appendChild(clearBtn);
    composer.appendChild(selectionBar);
  }

  const formRow = document.createElement('form');
  formRow.className = 'composer-form-row';
  formRow.addEventListener('submit', (e) => {
    e.preventDefault();
    void handleSendMessage();
  });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'composer-input';
  input.placeholder = 'メッセージを入力';
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
    if (state.checkpoints.length > 1) {
      const header = document.createElement('header');
      header.className = 'studio-header';
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

    const evalBtn = document.createElement('button');
    evalBtn.type = 'button';
    evalBtn.className = 'btn-bottom-evaluate';
    evalBtn.disabled = state.evaluateLoading;
    evalBtn.innerHTML = `${ICONS.evaluate}<span>${state.evaluateLoading ? '採点中...' : '採点する'}</span>`;
    evalBtn.addEventListener('click', () => {
      void handleEvaluate();
    });

    bottomBarEl.append(modeSwitch, evalBtn);
  }

  if (chatSlotEl) {
    chatSlotEl.innerHTML = '';
    const chatPanel = renderChatPanel(spec);
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
        onToast: (msg, t) => showSandboxToast(msg, t),
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
