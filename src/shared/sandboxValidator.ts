import {
  applyActions,
  createInitialState,
  evaluateExpression,
  hasCompletionAction,
  isComponentVisible,
  isHonestOptInComponent,
  isInputFilled,
  matchesCondition,
  renderLabel,
  type AppState,
} from './appRuntime.ts';
import type {
  AppComponent,
  AppSpec,
  ComponentBoundsInput,
  ComponentSize,
  ReviewerPersona,
  ReviewOutcome,
  SandboxValidationResult,
} from './types.ts';

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_CSS_COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|hsl|oklch)a?\([0-9.,%\s/deg+-]+\))$/;

function sanitizeCssColor(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim() ?? '';
  return SAFE_CSS_COLOR_RE.test(trimmed) ? trimmed : fallback;
}

/**
 * お題アプリ仕様 (AppSpec) から、iframe 内で単一HTMLとして独立動作する HTML 文字列を生成する。
 * タスク完了時には window.parent.postMessage({ type: 'PONKOTSU_TASK_COMPLETED' }, '*') を発火する。
 */
export function buildStandaloneSandboxHtml(spec: AppSpec): string {
  const safeTitle = escapeHtml(spec.title || 'お題アプリ');
  const bg = sanitizeCssColor(spec.theme?.bgColor, '#ffffff');
  const fg = sanitizeCssColor(spec.theme?.textColor, '#1c1917');
  const serializedSpec = JSON.stringify(spec).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* スマホ画面の幅に合わせて文字の基準を伸び縮みさせ、端末が大きく表示されたら中身も大きくする */
    html { font-size: 4.2vw; }
    html, body {
      width: 100%;
      height: 100%;
      font-family: "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "BIZ UDPGothic", "Hiragino Sans", "Noto Sans JP", sans-serif;
      font-weight: 700;
      background: ${bg};
      color: ${fg};
      overflow: hidden;
    }
    #sandbox-mount {
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <div id="sandbox-mount" data-spec-id="${escapeHtml(spec.id)}"></div>
  <script id="ponkotsu-spec-data" type="application/json">${serializedSpec}</script>
</body>
</html>`;
}

export interface ValidateSandboxOptions {
  requireTaskCompletionEvent?: boolean;
  previousSpec?: AppSpec;
  touchedComponentIds?: ReadonlySet<string>;
}

/**
 * 改修後の AppSpec が単一HTMLとして描画可能か、タスク完了イベントが残っているか、
 * またパッチ対象外の部品が勝手に書き換わっていないかを検証する。
 */
export function validateSandboxSpec(
  spec: AppSpec,
  options: ValidateSandboxOptions = {},
): SandboxValidationResult {
  const errors: string[] = [];

  if (!spec || typeof spec !== 'object') {
    return {
      valid: false,
      canRenderHtml: false,
      hasTaskCompletionEvent: false,
      untouchedComponentsIntact: false,
      errors: ['アプリ仕様データが空または不正です'],
    };
  }

  if (!Array.isArray(spec.components) || spec.components.length === 0) {
    errors.push('画面に表示する部品が1つもありません');
  }

  if (!Array.isArray(spec.state) || spec.state.length === 0) {
    errors.push('状態データ定義が失われています');
  }

  // 単一HTML生成テスト
  let canRenderHtml = false;
  try {
    const html = buildStandaloneSandboxHtml(spec);
    canRenderHtml = html.includes('<!DOCTYPE html>') && html.includes('ponkotsu-spec-data');
  } catch {
    canRenderHtml = false;
    errors.push('単一HTMLの組み立てに失敗しました');
  }

  // タスク完了イベント（complete_task を持つボタン）が存在するかチェック
  const hasTaskCompletionEvent = Array.isArray(spec.components)
    ? spec.components.some(
        (c) => c.type === 'button' && Array.isArray(c.actions) && hasCompletionAction(c),
      )
    : false;

  if (options.requireTaskCompletionEvent && !hasTaskCompletionEvent) {
    errors.push('タスク完了イベント complete_task を持つボタンが見つかりません');
  }

  // 計算式が読めるか・部品が参照している状態キーが存在するか
  if (Array.isArray(spec.state)) {
    const state = Object.fromEntries(spec.state.map((v) => [v.key, v.initialValue]));
    const knownKeys = new Set<string>(spec.state.map((v) => v.key));
    for (const d of spec.derived ?? []) {
      knownKeys.add(d.key);
      try {
        evaluateExpression(d.expression, state);
      } catch {
        errors.push(`計算式 ${d.key} を読めません`);
      }
    }
    for (const comp of spec.components ?? []) {
      if (comp.stateKey && !knownKeys.has(comp.stateKey)) {
        errors.push(`部品 ${comp.id} が参照する状態キー ${comp.stateKey} が定義されていません`);
      }
      if (comp.visibleWhen?.stateKey && !knownKeys.has(comp.visibleWhen.stateKey)) {
        errors.push(`部品 ${comp.id} の表示条件キー ${comp.visibleWhen.stateKey} が定義されていません`);
      }
    }
  }

  // パッチ対象外の部品が変わっていないかチェック
  let untouchedComponentsIntact = true;
  if (options.previousSpec && options.touchedComponentIds && Array.isArray(spec.components)) {
    for (const prevComp of options.previousSpec.components) {
      if (options.touchedComponentIds.has(prevComp.id)) continue;
      const nextComp = spec.components.find((c) => c.id === prevComp.id);
      if (!nextComp || JSON.stringify(nextComp) !== JSON.stringify(prevComp)) {
        untouchedComponentsIntact = false;
        errors.push(`変更対象外の部品 ${prevComp.id} が書き換わっています`);
      }
    }
  }

  return {
    valid: errors.length === 0 && canRenderHtml,
    canRenderHtml,
    hasTaskCompletionEvent,
    untouchedComponentsIntact,
    errors,
  };
}


// ============================================================================
// 操作シミュレーター
// ============================================================================

export interface ComputerUseSimulationResult {
  outcome: ReviewOutcome;
  frictionPoint: string;
  simulatedComment: string;
  actionTrace: string[];
  appliedConstraintNote: string;
  /** 完了したときの状態（定期便に入ったままか等、お店の側の集計に使う） */
  finalState?: AppState;
}

interface SimulatedBox {
  comp: AppComponent;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

const SCREEN_WIDTH = 320;
const HEIGHT_BY_SIZE: Record<ComponentSize, number> = { xs: 26, sm: 34, md: 44, lg: 56, xl: 68 };
const SIZE_RANK: Record<ComponentSize, number> = { xs: 0, sm: 1, md: 2, lg: 3, xl: 4 };
/** 片手の親指が届く横位置の上限 */
const ONE_HAND_REACH_X = 230;
/** 1手あたりの操作時間・邪魔な表示1つあたり・漢数字を読む時間・ポップアップを閉じる時間（ミリ秒） */
const MS_PER_STEP = 1200;
const MS_PER_DISTRACTION = 700;
const MS_KANJI_READING = 2000;
const MS_POPUP = 1500;
const MAX_SCREENS = 6;

/** 部品の種類ごとの高さの見積もり（px）。種類で決まらないものは文字サイズで決める */
function estimateHeight(comp: AppComponent): number {
  switch (comp.type) {
    case 'product_card':
      return 128;
    case 'choice_cards':
      return 16 + 60 * Math.max(1, comp.options?.length ?? 1);
    case 'summary':
      return 24 + 26 * Math.max(1, comp.rows?.length ?? 1);
    case 'progress_steps':
      return 28;
    default:
      return HEIGHT_BY_SIZE[comp.style.size] ?? 42;
  }
}

/**
 * 画面上の各部品の擬似バウンディングボックスを算出する（実DOM座標があればそれを使用）。
 * ポップアップは画面に重なるため並びには含めない。sticky の部品は画面下のバーに横並びで置く。
 */
function layoutComponentBoxes(
  components: AppComponent[],
  customBounds?: ComponentBoundsInput[],
): SimulatedBox[] {
  const customMap = new Map((customBounds ?? []).map((b) => [b.id, b]));
  const boxes: SimulatedBox[] = [];
  const toBox = (comp: AppComponent, left: number, top: number, w: number, h: number): SimulatedBox => ({
    comp,
    left,
    top,
    right: left + w,
    bottom: top + h,
    centerX: left + w / 2,
    centerY: top + h / 2,
    width: w,
    height: h,
  });
  let cursorY = 58;

  const flow = components.filter((c) => c.type !== 'popup' && !c.style.sticky);
  const sticky = components.filter((c) => c.type !== 'popup' && c.style.sticky);

  for (const comp of [...flow, ...sticky]) {
    const existing = customMap.get(comp.id);
    if (existing && existing.right > existing.left && existing.bottom > existing.top) {
      boxes.push(
        toBox(comp, existing.left, existing.top, existing.right - existing.left, existing.bottom - existing.top),
      );
      continue;
    }
    if (comp.style.sticky) continue;

    const h = estimateHeight(comp);
    const isFull =
      comp.style.fullWidth ||
      comp.style.size === 'lg' ||
      comp.style.size === 'xl' ||
      ['product_card', 'choice_cards', 'summary', 'progress_steps'].includes(comp.type);
    const w = isFull ? SCREEN_WIDTH - 32 : comp.style.size === 'xs' ? 92 : 160;
    let left = 16;
    if (!isFull) {
      if (comp.style.align === 'right') {
        left = SCREEN_WIDTH - 16 - w;
      } else if (comp.style.align === 'center') {
        left = (SCREEN_WIDTH - w) / 2;
      }
    }
    boxes.push(toBox(comp, left, cursorY, w, h));
    cursorY += h + 8;
  }

  // 画面下に固定したバー：合計などの表示を左に、ボタンを右に並べる
  const stickyWithoutBounds = sticky.filter((c) => !customMap.has(c.id));
  if (stickyWithoutBounds.length > 0) {
    const barTop = cursorY + 8;
    const buttons = stickyWithoutBounds.filter((c) => c.type === 'button');
    const others = stickyWithoutBounds.filter((c) => c.type !== 'button');
    const othersWidth = others.length > 0 ? 110 : 0;
    others.forEach((comp, i) => {
      const w = othersWidth / others.length;
      boxes.push(toBox(comp, 16 + i * w, barTop, w, 56));
    });
    const buttonsLeft = 16 + othersWidth + (others.length > 0 ? 12 : 0);
    const buttonsWidth = SCREEN_WIDTH - 16 - buttonsLeft;
    buttons.forEach((comp, i) => {
      const w = buttonsWidth / buttons.length;
      boxes.push(toBox(comp, buttonsLeft + i * w, barTop, w, 54));
    });
  }

  return boxes;
}

/**
 * ペルソナIDと手数から決定論的なズレ量（-jitterPx 〜 +jitterPx）を算出する。
 * テストの再現性を保ちつつ、指の震え・片手操作・電車の揺れによる誤タップを再現する。
 */
function computeDeterministicJitter(
  personaId: string,
  step: number,
  jitterPx: number,
): { dx: number; dy: number } {
  let hash = step * 31;
  for (let i = 0; i < personaId.length; i++) {
    hash = (hash * 33 + personaId.charCodeAt(i)) % 997;
  }
  const normX = ((hash % 200) - 100) / 100;
  const normY = (((hash * 7) % 200) - 100) / 100;
  // 指のズレが大きいペルソナほど端方向にズレが出るように最低65%の振幅を持たせる
  const magX = Math.max(0.65, Math.abs(normX)) * jitterPx * (normX >= 0 ? 1 : -1);
  const magY = Math.max(0.65, Math.abs(normY)) * jitterPx * (normY >= 0 ? 1 : -1);
  return { dx: Math.round(magX), dy: Math.round(magY) };
}

/** 視力制約から、読み取れる最小の文字サイズを決める */
function minReadableRank(persona: ReviewerPersona): number {
  const blur = persona.constraints.blurPx;
  if (blur >= 3) return SIZE_RANK.lg;
  if (blur >= 2) return SIZE_RANK.md;
  if (blur >= 1.2) return SIZE_RANK.sm;
  return SIZE_RANK.xs;
}

function canRead(comp: AppComponent, persona: ReviewerPersona): boolean {
  let rank = SIZE_RANK[comp.style.size] ?? SIZE_RANK.md;
  // 薄い色の文字は、コントラストが落ちている人には一段小さく見える
  if (comp.style.variant === 'muted' && persona.constraints.contrast < 0.8) rank -= 1;
  return rank >= minReadableRank(persona);
}

/** 目立ち具合。読めないときや細かく読まない人は、一番目立つボタンを押す */
function prominence(comp: AppComponent): number {
  const s = comp.style;
  return (
    (SIZE_RANK[s.size] ?? 2) * 10 +
    (['primary', 'danger', 'warning'].includes(s.variant) ? 4 : 0) +
    (s.fullWidth ? 2 : 0) +
    (s.noisyAnimation ? 3 : 0)
  );
}

type FailureReason =
  | 'popup_unclosable'
  | 'popup_tapped'
  | 'clutter'
  | 'unreadable_input'
  | 'unreachable'
  | 'hit_danger'
  | 'left_page'
  | 'decoy_only'
  | 'no_response'
  | 'no_target'
  | 'too_many_steps'
  | 'timeout'
  | 'no_confirmation'
  | 'total_unreadable';

const FAILURE_TEXT: Record<FailureReason, { friction: string; comment: string }> = {
  popup_unclosable: {
    friction: '広告の閉じるボタンが見えない',
    comment: '広告の閉じるボタンが見えなくて、先に進めなかった',
  },
  popup_tapped: {
    friction: '広告を閉じようとして押してしまった',
    comment: '広告を閉じようとしたら、広告のほうを押してしまった',
  },
  clutter: {
    friction: '関係ない表示が多くて迷った',
    comment: '関係ない表示が多すぎて、どこを見ればいいのか分からなかった',
  },
  unreadable_input: {
    friction: '入力欄の文字が読めない',
    comment: '入力欄の文字が小さくて、何を選べばいいのか読めなかった',
  },
  unreachable: {
    friction: 'ボタンに指が届かない',
    comment: '片手だとボタンに指が届かなかった',
  },
  hit_danger: {
    friction: '押し間違えて入力が消えた',
    comment: '押し間違えて、入力した内容が全部消えてしまった',
  },
  left_page: {
    friction: '別のページに飛ばされた',
    comment: 'ボタンを押したら別のページに飛ばされて、注文が途中で終わった',
  },
  decoy_only: {
    friction: 'それらしいボタンが反応しない',
    comment: '目立つボタンを押しても何も起きなくて、あきらめた',
  },
  no_response: {
    friction: '注文ボタンが反応しない',
    comment: '注文ボタンを押しても何も起きなかった',
  },
  no_target: {
    friction: '注文するボタンが見つからない',
    comment: '注文するボタンがどこにあるのか分からなかった',
  },
  too_many_steps: {
    friction: '手順が多すぎる',
    comment: 'やることが多すぎて、途中で面倒になった',
  },
  timeout: {
    friction: '時間がかかりすぎる',
    comment: '時間がかかりすぎて、途中でやめてしまった',
  },
  no_confirmation: {
    friction: '注文前に確認できない',
    comment: '確かめられないまま注文するのが怖くて、押せなかった',
  },
  total_unreadable: {
    friction: '合計金額がすぐ分からない',
    comment: '結局いくら払うのかすぐ分からなくて、買うのをやめた',
  },
};

function describeConstraints(persona: ReviewerPersona): string {
  const c = persona.constraints;
  return [
    c.blurPx >= 2.0 ? `視力ぼかし${c.blurPx}px` : '',
    c.contrast <= 0.7 ? `低コントラスト${Math.round(c.contrast * 100)}%` : '',
    c.jitterPx >= 15 ? `指のズレ±${c.jitterPx}px` : '',
    `手数上限${c.maxSteps}手`,
    c.environment === 'one_hand' ? '片手親指操作' : c.environment === 'moving_train' ? '揺れる車内' : '',
    c.readsFinePrint ? '細かい字も読む' : '細かい字は読み飛ばす',
    c.wantsConfirmation ? '確認したい' : '',
    c.needsReadableTotal ? '合計金額を確かめたい' : '',
    c.dislikesPressure ? '急かされるのが嫌い' : '',
  ]
    .filter(Boolean)
    .join('・');
}

/**
 * 操作シミュレーター。部品の役割（role）だけを見て、ペルソナの制約のもとで画面を最後まで操作してみる。
 *
 * - 視力制約: 小さい文字・薄い文字を読めず、読めないときは一番目立つボタンを押す
 * - 指の正確さ: 押す位置にズレを加え、外れた先が危険なボタンなら離脱
 * - 手数と時間: 手数上限・待てる時間を超えたら離脱
 * - 罠: 細かい字を読む人だけが気づいて直す。気づかずに完了したら後悔
 * - 完了判定: complete_task が実行されたかどうかをコードで判定する
 */
export function simulatePersonaComputerUse(
  spec: AppSpec,
  persona: ReviewerPersona,
  customBounds?: ComponentBoundsInput[],
): ComputerUseSimulationResult {
  const c = persona.constraints;
  const actionTrace: string[] = [];
  const appliedConstraintNote = describeConstraints(persona);

  let state: AppState = createInitialState(spec);
  let steps = 0;
  let elapsedMs = 0;
  let confirmedOnEarlierScreen = false;
  let kanjiPenaltyApplied = false;
  const closedPopups = new Set<string>();
  const noticedTrapIds = new Set<string>();
  const triedDecoyIds = new Set<string>();
  let pressureNoticed = false;
  /** 買えたとしても嫌な思いをしたこと。1つでもあれば「買えたけど不満」になる */
  const bothers: Array<{ friction: string; comment: string }> = [];

  const fail = (reason: FailureReason): ComputerUseSimulationResult => ({
    outcome: 'abandoned',
    frictionPoint: FAILURE_TEXT[reason].friction,
    simulatedComment: FAILURE_TEXT[reason].comment,
    actionTrace,
    appliedConstraintNote,
  });

  const overBudget = (): FailureReason | null => {
    if (steps > c.maxSteps) return 'too_many_steps';
    if (elapsedMs > c.patienceMs) return 'timeout';
    return null;
  };

  /**
   * 部品を1回押す。外れた先も判定する。
   * 戻り値: hit=狙いどおり / miss=空振り / danger=危険な部品に当たった / unreachable=届かない
   */
  const tap = (
    box: SimulatedBox,
    boxes: SimulatedBox[],
  ): 'hit' | 'miss' | 'danger' | 'unreachable' => {
    steps++;
    elapsedMs += MS_PER_STEP;
    if (c.environment === 'one_hand' && !box.comp.style.fullWidth && box.centerX > ONE_HAND_REACH_X) {
      actionTrace.push(`${steps}手目: 右端の${box.comp.label}に親指が届かない`);
      return 'unreachable';
    }
    const { dx, dy } = computeDeterministicJitter(persona.id, steps, c.jitterPx);
    // 傾いた部品は当たり判定が狭くなる
    const tilt = Math.abs(box.comp.style.rotateDeg ?? 0) > 5 ? 0.6 : 1;
    const hit = Math.abs(dx) <= (box.width / 2) * tilt && Math.abs(dy) <= (box.height / 2) * tilt;
    if (hit) return 'hit';

    const x = box.centerX + dx;
    const y = box.centerY + dy;
    const other = boxes.find(
      (b) => b !== box && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom,
    );
    if (other?.comp.role === 'danger' && other.comp.type === 'button') {
      actionTrace.push(`${steps}手目: 指がズレて${other.comp.label}を押してしまった`);
      return 'danger';
    }
    actionTrace.push(`${steps}手目: ${box.comp.label}を狙ったが指がズレて外れた`);
    return 'miss';
  };

  /**
   * 出現時間を過ぎたポップアップを閉じる。ポップアップは操作の途中で時間差に現れるため、
   * 手早く終える人は出る前に完了できることがある。
   */
  const closeDuePopups = (): FailureReason | null => {
    const due = spec.components.filter(
      (comp) =>
        comp.role === 'popup' &&
        !closedPopups.has(comp.id) &&
        (!comp.stateKey || state[comp.stateKey] !== 'closed') &&
        elapsedMs >= (comp.popupDelayMs?.min ?? 0),
    );
    for (const popup of due) {
      closedPopups.add(popup.id);
      steps++;
      elapsedMs += MS_POPUP;
      if (!canRead(popup, persona)) {
        actionTrace.push(`${steps}手目: ${popup.label}が画面を覆い、閉じるボタンが見えない`);
        return 'popup_unclosable';
      }
      const closeHalf = HEIGHT_BY_SIZE[popup.style.size] / 2;
      const { dx, dy } = computeDeterministicJitter(persona.id, steps, c.jitterPx);
      if (Math.abs(dx) > closeHalf || Math.abs(dy) > closeHalf) {
        actionTrace.push(`${steps}手目: 広告の小さな閉じるボタンを外し、広告を押してしまった`);
        return 'popup_tapped';
      }
      actionTrace.push(`${steps}手目: ${popup.label}を閉じた`);
      bothers.push({ friction: '途中で広告を閉じさせられた', comment: '途中で広告が出てきて、閉じるのが面倒だった' });
    }
    return null;
  };

  /** 外れたら手数の許す限り押し直す */
  const tapUntilHit = (
    box: SimulatedBox,
    boxes: SimulatedBox[],
  ): 'hit' | FailureReason => {
    for (;;) {
      const popupFailure = closeDuePopups();
      if (popupFailure) return popupFailure;
      const result = tap(box, boxes);
      if (result === 'hit') return 'hit';
      if (result === 'danger') return 'hit_danger';
      if (result === 'unreachable') return 'unreachable';
      const budget = overBudget();
      if (budget) return budget;
    }
  };

  for (let screen = 0; screen < MAX_SCREENS; screen++) {
    const visible = spec.components.filter((comp) => isComponentVisible(comp, state));
    const boxes = layoutComponentBoxes(visible, customBounds);
    const boxOf = (comp: AppComponent) => boxes.find((b) => b.comp === comp);

    // 1. すでに出ているポップアップを閉じる
    const popupFailure = closeDuePopups();
    if (popupFailure) return fail(popupFailure);

    // 2. 関係ない表示が多すぎると迷う
    const distractions = visible.filter((comp) => comp.role === 'distraction').length;
    if (distractions > c.clutterTolerance) {
      actionTrace.push(`画面確認: 関係ない表示が${distractions}個あり、どこを見ればいいか迷って離脱`);
      return fail('clutter');
    }
    elapsedMs += distractions * MS_PER_DISTRACTION;

    // 偽の残り時間などで急かされると、急かされるのが嫌いな人は買えても不満が残る
    const pressure = visible.find(
      (comp) => comp.darkPattern === 'false_urgency' || comp.label.includes('{countdown}'),
    );
    if (pressure && c.dislikesPressure && !pressureNoticed) {
      pressureNoticed = true;
      actionTrace.push(`画面確認: ${renderLabel(pressure, state)}で急かされて嫌な気分になった`);
      bothers.push({ friction: '残り時間で急かされた', comment: '残り時間で急かされて、落ち着いて選べなかった' });
    }

    // 漢数字の値段は読むのに時間がかかる
    if (!kanjiPenaltyApplied && visible.some((comp) => comp.style.numberFormat === 'kanji')) {
      kanjiPenaltyApplied = true;
      elapsedMs += MS_KANJI_READING;
      actionTrace.push('画面確認: 漢数字の値段を読むのに時間がかかった');
      bothers.push({ friction: '値段が読みにくかった', comment: '値段が漢数字で、いくらなのか読むのに手間取った' });
    }

    // 3. 必須の入力欄を埋める
    for (const comp of visible.filter((v) => v.role === 'required_input')) {
      if (isInputFilled(comp, state)) continue;
      if (!canRead(comp, persona)) {
        actionTrace.push(`画面確認: ${comp.label}の文字が小さくて読めず離脱`);
        return fail('unreadable_input');
      }
      const box = boxOf(comp);
      if (!box) continue;
      const result = tapUntilHit(box, boxes);
      if (result !== 'hit') return fail(result);
      if (comp.stateKey) {
        const option = comp.options?.find((o) => o !== comp.placeholder);
        state = { ...state, [comp.stateKey]: option ?? '入力済み' };
      }
      actionTrace.push(`${steps}手目: ${comp.label}を入力した`);
      const budget = overBudget();
      if (budget) return fail(budget);
    }

    // 4. 罠に気づけば直す（細かい字を読む人が、読める大きさの場合だけ）
    for (const comp of visible.filter((v) => v.role === 'trap' && v.trapWhen)) {
      if (!matchesCondition(comp.trapWhen!, state)) continue;
      if (!c.readsFinePrint || !canRead(comp, persona)) continue;
      noticedTrapIds.add(comp.id);
      if (comp.trapSafeValue === undefined || !comp.stateKey) {
        actionTrace.push(`画面確認: ${comp.label}に気づいたうえで進む`);
        bothers.push({ friction: '分かりにくい条件が付いていた', comment: `${comp.label}に気づいたけど、なんだか気分が悪い` });
        continue;
      }
      const box = boxOf(comp);
      if (!box) continue;
      const result = tapUntilHit(box, boxes);
      if (result !== 'hit') return fail(result);
      state = { ...state, [comp.stateKey]: comp.trapSafeValue };
      actionTrace.push(`${steps}手目: ${comp.label}に気づいて直した`);
      bothers.push({ friction: '勝手に付いていた申し込みを外した', comment: `危うく${comp.label}のまま買うところだった` });
      const budget = overBudget();
      if (budget) return fail(budget);
    }

    // 4b. 正直な定期便（最初からOFF・読める文字サイズ・不当な縛り文言なし）なら、よく読む人は自分の意思で申し込む
    for (const comp of visible.filter(
      (v) =>
        v.stateKey === 'subscription' &&
        (v.type === 'checkbox' || v.type === 'toggle'),
    )) {
      const initialSub = spec.state.find((s) => s.key === 'subscription')?.initialValue;
      const isHonest =
        isHonestOptInComponent(comp, initialSub) &&
        state.subscription === false &&
        canRead(comp, persona);
      if (isHonest && c.readsFinePrint && !noticedTrapIds.has(comp.id)) {
        noticedTrapIds.add(comp.id);
        state = { ...state, subscription: true };
        actionTrace.push(`${steps}手目: 条件が分かりやすいので${comp.label}を自分で選んだ`);
      }
    }

    // 確認画面（2画面目以降）で内容表示の文字が小さすぎて読めないと不満が残る
    if (screen > 0) {
      const unreadableConfirmInfo = visible.find(
        (v) => (v.role === 'info' || v.role === 'total') && !canRead(v, persona),
      );
      if (unreadableConfirmInfo) {
        bothers.push({
          friction: '確認画面の文字が小さかった',
          comment: '確認画面の文字が小さくて、内容を確かめづらかった',
        });
      }
    }

    // 5. 押すボタンを決める
    const buttons = boxes.filter((b) => b.comp.type === 'button');
    const candidates = buttons.filter(
      (b) =>
        (b.comp.role === 'primary_action' || b.comp.role === 'decoy') &&
        !triedDecoyIds.has(b.comp.id),
    );
    const readable = candidates.filter((b) => canRead(b.comp, persona));
    const pool = readable.length > 0 ? readable : buttons;
    if (pool.length === 0) {
      actionTrace.push('画面確認: 進むためのボタンが見つからず離脱');
      return fail('no_target');
    }
    const preferred =
      c.readsFinePrint && readable.length > 0
        ? readable.filter((b) => b.comp.role === 'primary_action')
        : [];
    const target = (preferred.length > 0 ? preferred : pool).reduce((best, b) =>
      prominence(b.comp) > prominence(best.comp) ? b : best,
    );

    // 完了ボタンを押す前の確認
    const isCompletion = hasCompletionAction(target.comp);
    if (isCompletion && c.needsReadableTotal) {
      const totals = visible.filter((comp) => comp.role === 'total');
      const readableTotal = totals.some(
        (comp) => canRead(comp, persona) && comp.style.numberFormat !== 'kanji',
      );
      if (!readableTotal) {
        actionTrace.push('画面確認: 合計金額がすぐに読み取れず、買うのをやめた');
        return fail('total_unreadable');
      }
    }
    const confirmsOnTap = target.comp.behavior?.effect === 'confirm_dialog';
    if (isCompletion && c.wantsConfirmation && !confirmedOnEarlierScreen && !confirmsOnTap) {
      actionTrace.push(`画面確認: 確認なしで${target.comp.label}を押すのが怖くて離脱`);
      return fail('no_confirmation');
    }

    // 6. 押す
    const tapResult = tapUntilHit(target, boxes);
    if (tapResult !== 'hit') {
      if (tapResult === 'hit_danger' && target.comp.role === 'danger') return fail('hit_danger');
      return fail(tapResult);
    }
    if (target.comp.role === 'danger') {
      actionTrace.push(`${steps}手目: 一番目立つ${target.comp.label}を押してしまい、入力が消えた`);
      return fail('hit_danger');
    }

    const effect = target.comp.behavior?.effect ?? 'none';
    if (effect === 'require_3_clicks') {
      steps += 2;
      elapsedMs += MS_PER_STEP * 2;
    } else if (effect === 'escape_on_hover') {
      steps += 1;
      elapsedMs += MS_PER_STEP;
    } else if (confirmsOnTap) {
      steps += 1;
      elapsedMs += MS_PER_STEP;
    }
    const budget = overBudget();
    if (budget) {
      actionTrace.push(`${steps}手目: ${target.comp.label}を押したが、手順が多すぎて離脱`);
      return fail(budget);
    }

    if (target.comp.actions.length === 0) {
      if (target.comp.role === 'decoy') {
        actionTrace.push(`${steps}手目: 目立つ${target.comp.label}を押したが何も起きない`);
        triedDecoyIds.add(target.comp.id);
        bothers.push({ friction: '目立つボタンが効かなかった', comment: `${target.comp.label}を押しても何も起きなくて焦った` });
        screen--;
        if (triedDecoyIds.size >= 3) return fail('decoy_only');
        continue;
      }
      actionTrace.push(`${steps}手目: ${target.comp.label}を押したが何も起きず離脱`);
      return fail('no_response');
    }

    const result = applyActions(spec, state, target.comp.actions);
    state = result.state;

    if (result.openedPage && !result.completed) {
      actionTrace.push(`${steps}手目: ${target.comp.label}を押したら${result.openedPage}のページに飛ばされた`);
      return fail('left_page');
    }

    if (result.completed) {
      // 7. 完了。気づかなかった罠が残っていれば後悔
      const activeTraps = spec.components.filter(
        (comp) =>
          comp.role === 'trap' &&
          comp.trapWhen &&
          matchesCondition(comp.trapWhen, state) &&
          !noticedTrapIds.has(comp.id),
      );
      if (activeTraps.length > 0) {
        actionTrace.push(
          `${steps}手目: ${target.comp.label}で完了したが、${activeTraps.map((t) => t.label).join('と')}に気づかなかった`,
        );
        return {
          outcome: 'regretted',
          frictionPoint: '気づかないまま余計な契約をした',
          simulatedComment: `注文はできたけど、あとで${activeTraps[0].label}になっていたと気づいた`,
          actionTrace,
          appliedConstraintNote,
          finalState: state,
        };
      }
      actionTrace.push(`${steps}手目: ${target.comp.label}を押してタスク完了イベントを検知`);
      if (bothers.length > 0) {
        return {
          outcome: 'bothered',
          frictionPoint: bothers[0].friction,
          simulatedComment: `買えたけど、${bothers[0].comment}`,
          actionTrace,
          appliedConstraintNote,
          finalState: state,
        };
      }
      return {
        outcome: 'achieved',
        frictionPoint: `${steps}手で迷わず完了`,
        simulatedComment: '迷わずに最後まで注文できた',
        actionTrace,
        appliedConstraintNote,
        finalState: state,
      };
    }

    // 完了しなかった場合は次の画面へ（確認画面など）
    actionTrace.push(`${steps}手目: ${target.comp.label}を押して次の画面へ`);
    confirmedOnEarlierScreen = true;
  }

  actionTrace.push('画面を行き来するだけで完了にたどり着けず離脱');
  return fail('too_many_steps');
}
