// お題アプリのハイブリッド構造化スキーマ (判断1: 案C)
// UI部品ツリーと状態変数は型安全なJSONで管理し、単一HTMLとしてiframe内で隔離実行する。

import type { Rect2D } from './hitTest.ts';

export type StateValue = string | number | boolean;

export interface AppStateVar {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  initialValue: StateValue;
}

/**
 * - progress_steps: 手順の表示。options が手順名、label が今の手順
 * - product_card: 商品カード。label が商品名、badge・caption・priceLabel を添え、stateKey の数量を±ボタンで変える
 * - choice_cards: 選べるカード。options が選択肢、optionDetails が各選択肢の補足
 * - summary: 金額の内訳。rows に行を並べる
 */
export type ComponentType =
  | 'heading'
  | 'text'
  | 'product_hero'
  | 'product_card'
  | 'progress_steps'
  | 'choice_cards'
  | 'summary'
  | 'input'
  | 'select'
  | 'checkbox'
  | 'toggle'
  | 'slider'
  | 'button'
  | 'status_banner'
  | 'popup';

export type ComponentSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type ComponentVariant = 'default' | 'primary' | 'danger' | 'warning' | 'success' | 'muted';

export interface ComponentStyle {
  size: ComponentSize;
  variant: ComponentVariant;
  align?: 'left' | 'center' | 'right';
  fullWidth?: boolean;
  noisyAnimation?: boolean;
  /** 部品を傾ける角度（度）。0 または未指定でまっすぐ */
  rotateDeg?: number;
  /** ラベル内の {状態キー} に差し込む数値の表記。kanji で漢数字にする */
  numberFormat?: 'arabic' | 'kanji';
  /** true なら画面下に固定したバーに置く（合計金額と購入ボタンなど） */
  sticky?: boolean;
  /**
   * 見た目の系統。native は元のデザインに揃える。
   * intrusive は後から付け足されたように、元のデザインの決まりを無視した見た目で描く
   */
  skin?: 'native' | 'intrusive';
}

export type BehaviorEffect = 'none' | 'escape_on_hover' | 'require_3_clicks' | 'confirm_dialog';

export interface ComponentBehavior {
  effect: BehaviorEffect;
  confirmText?: string;
}

export type ActionType =
  | 'set_state'
  | 'toggle_state'
  | 'increment_state'
  | 'reset_all'
  | 'show_toast'
  | 'open_page'
  | 'complete_task';

/**
 * - open_page: 別のページに飛ばす。message がそのページの見出しになり、少しすると最初の画面に戻る
 * - complete_task: タスク完了。message が完了ページの見出しになり、少しすると最初の画面に戻る
 */
export interface ComponentAction {
  type: ActionType;
  targetKey?: string;
  value?: StateValue;
  message?: string;
}

export interface VisibilityCondition {
  stateKey: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt';
  value: StateValue;
}

/**
 * 部品が画面の中で果たす役割。操作シミュレーターは部品のIDではなく役割を見て判定する。
 * - primary_action: タスクを先へ進める本物のボタン（complete_task を持つもの、確認画面へ進むもの）
 * - decoy: 本物らしく見えるが押しても何も起きないおとり
 * - danger: 押すと入力が消えるなど、誤って押すと離脱につながるボタン
 * - required_input: タスク完了までに入力が必要な欄。値が空か placeholder と同じなら未入力
 * - distraction: タスクと関係ない項目や煽り表示
 * - trap: 気づかずに完了すると後悔につながる項目（最初からチェックの入った定期便など）
 * - total: 支払う合計金額などタスクの結果を示す表示
 * - popup: 時間差で画面を覆う広告など
 * - info: 上記以外の説明表示
 */
export type ComponentRole =
  | 'primary_action'
  | 'decoy'
  | 'danger'
  | 'required_input'
  | 'distraction'
  | 'trap'
  | 'total'
  | 'popup'
  | 'info';

export interface AppComponent {
  id: string;
  type: ComponentType;
  role: ComponentRole;
  label: string;
  /** product_hero・product_card に表示する絵。coffee_bag ならコーヒー袋のイラスト、それ以外は絵文字として描く */
  icon?: string;
  /** product_card の上に添える小さな札（例: 深煎り・ブラジル） */
  badge?: string;
  /** label の下に添える補足。{状態キー} を差し込める */
  caption?: string;
  /** product_card の値段。{状態キー} を差し込める（例: ¥{unitPrice}） */
  priceLabel?: string;
  /** choice_cards の各選択肢の補足（options と同じ順番） */
  optionDetails?: string[];
  /** summary の行。label と value に {状態キー} を差し込める */
  rows?: Array<{ label: string; value: string }>;
  placeholder?: string;
  options?: string[];
  stateKey?: string;
  style: ComponentStyle;
  behavior?: ComponentBehavior;
  visibleWhen?: VisibilityCondition;
  /** role が trap のとき、この条件が成り立ったまま完了すると後悔につながる */
  trapWhen?: VisibilityCondition;
  /** role が trap のとき、気づいた人が直す値。未指定なら気づいても直せない（承知のうえで進む） */
  trapSafeValue?: StateValue;
  /** popup が現れるまでの時間の範囲（ミリ秒）。この範囲でランダムに現れる */
  popupDelayMs?: { min: number; max: number };
  actions: ComponentAction[];
}

export interface AppTheme {
  bgColor: string;
  cardColor: string;
  textColor: string;
  accentColor: string;
  chaoticLayout: boolean;
}

/** 状態から計算して求める値（合計金額など）。式は四則演算・比較・三項演算子のみ */
export interface DerivedValue {
  key: string;
  expression: string;
}

export interface AppSpec {
  id: string;
  title: string;
  subtitle: string;
  taskDescription: string;
  theme: AppTheme;
  state: AppStateVar[];
  derived?: DerivedValue[];
  components: AppComponent[];
}

// 顧客層とペルソナ＋制約変数（題材ごとに定義する）
export type TargetCohortId = string;

export interface TargetCohortInfo {
  id: TargetCohortId;
  label: string;
  shortDesc: string;
}

export interface PersonaConstraints {
  /** 視力制約: スクリーンショットにかけるガウシアンぼかし半径(px) */
  blurPx: number;
  /** 視力制約: コントラスト倍率 (1.0が標準、低いほど見分けにくい) */
  contrast: number;
  /** 指の正確さ制約: クリック座標に加算される最大ズレ幅(px) */
  jitterPx: number;
  /** 手数の上限: この回数以内にタスク完了イベントが出なければ離脱 */
  maxSteps: number;
  /** 待てる時間(ms): 操作完了までに許容する最大時間 */
  patienceMs: number;
  /** 使用環境タグ */
  environment: 'normal' | 'one_hand' | 'moving_train';
  /** 関係ない項目・煽り表示・広告をいくつまで無視できるか */
  clutterTolerance: number;
  /** 細かい文字やチェック欄まで読む。読める大きさなら罠に気づける */
  readsFinePrint: boolean;
  /** 完了前に確認の機会がないと不安で押せない */
  wantsConfirmation: boolean;
  /** 合計金額がすぐ読めないと完了しない */
  needsReadableTotal: boolean;
}

export interface ReviewerPersona {
  id: string;
  cohortId: TargetCohortId;
  traitLabel: string;
  name: string;
  age: number;
  role: string;
  icon: string;
  goal: string;
  /** 来店時にお客さん本人が話す一言（口語） */
  greeting: string;
  focusPoint: string;
  constraints: PersonaConstraints;
}

export type ReviewDisposition = 'fix' | 'rebut_keep' | 'hold';

export interface ReviewerDispositionRecord {
  reviewerId: string;
  disposition: ReviewDisposition;
  reason: string;
  decidedAt: string;
}

/** 達成・離脱に加え、完了はできたが罠に気づかず後悔したケースを区別する */
export type ReviewOutcome = 'achieved' | 'abandoned' | 'regretted';

export interface ReviewerEvaluation {
  reviewerId: string;
  outcome: ReviewOutcome;
  frictionPoint: string;
  comment: string;
  /** Computer Use 実操作シミュレーションの軌跡ログ */
  actionTrace?: string[];
  /** 適用された制約変数の要約 */
  appliedConstraintNote?: string;
}

/** 店長が採点のたびに見る、お店の側の結果 */
export interface OwnerReport {
  /** 注文してくれた人数（後悔した人も注文は入っている） */
  orders: number;
  customers: number;
  metrics: Array<{ label: string; count: number; missing: boolean }>;
  /** 店長の一言 */
  comment: string;
}

export interface EvaluationResponse {
  evaluatedAt: string;
  cohortId?: TargetCohortId;
  results: ReviewerEvaluation[];
  owner?: OwnerReport;
}

// 人間の判断記録 (Own the Why / Function Calling で構造化記録)
export type DecisionStage = 'select_cohort' | 'apply_change' | 'review_disposition';

export interface HumanDecisionRecord {
  id: string;
  stage: DecisionStage;
  targetId: string;
  chosenLabel: string;
  reason: string;
  recordedVia: 'gemini_function_call' | 'local_function_call';
  createdAt: string;
}

export interface RecordDecisionRequest {
  stage: DecisionStage;
  targetId: string;
  chosenLabel: string;
  reason: string;
  cohortId?: TargetCohortId;
}

export interface RecordDecisionResponse {
  decision: HumanDecisionRecord;
  persistedToFirestore: boolean;
}

// サンドボックス検証結果
export interface SandboxValidationResult {
  valid: boolean;
  canRenderHtml: boolean;
  hasTaskCompletionEvent: boolean;
  untouchedComponentsIntact?: boolean;
  errors: string[];
}

// 差分パッチ操作（案B: 変更箇所だけを適用し、触っていない部品を保護する）
export type SpecPatchOp =
  | 'remove_component'
  | 'replace_component'
  | 'insert_component'
  | 'move_component'
  | 'upsert_state'
  | 'upsert_derived';

export type SpecPatch =
  | { op: 'remove_component'; id: string }
  | { op: 'replace_component'; component: AppComponent }
  | { op: 'insert_component'; afterId?: string | null; component: AppComponent }
  | { op: 'move_component'; id: string; afterId?: string | null }
  | { op: 'upsert_state'; variable: AppStateVar }
  | { op: 'upsert_derived'; key: string; expression: string };

/** AIに渡す直近の会話（発言者名と本文） */
export interface ChatHistoryEntry {
  speaker: string;
  text: string;
}

// 改修反映 API の入出力
export interface ApplyRequest {
  currentSpec: AppSpec;
  targetComponentIds: string[];
  userInstruction: string;
  selectionReason?: string;
  cohortId?: TargetCohortId;
  annotatedImageBase64?: string;
  history?: ChatHistoryEntry[];
}

export interface ApplyResponse {
  commitMessage: string;
  updatedSpec: AppSpec;
  patches?: SpecPatch[];
  ownerReaction?: string;
  validation?: SandboxValidationResult;
  rolledBack?: boolean;
  decisionRecord?: HumanDecisionRecord;
}

// レビュアー使用テスト API の入出力
export type ComponentBoundsInput = Rect2D;

export interface EvaluateRequest {
  currentSpec: AppSpec;
  cohortId?: TargetCohortId;
  screenshotBase64?: string;
  componentBounds?: ComponentBoundsInput[];
}

// チェックポイント履歴 (Gitのコミット相当)
export interface Checkpoint {
  id: string;
  stepNumber: number;
  commitMessage: string;
  createdAt: string;
  spec: AppSpec;
  evaluation?: EvaluationResponse;
}

// 自由対話タイムライン型ハイブリッド壁打ち API
/** explain は質問への回答、clarify は曖昧な発言への聞き返し、apply は改修の実行 */
export type ChatIntent = 'explain' | 'clarify' | 'apply';

export interface ChatRequest {
  currentSpec: AppSpec;
  targetComponentIds: string[];
  userMessage: string;
  cohortId?: TargetCohortId;
  annotatedImageBase64?: string;
  history?: ChatHistoryEntry[];
}

export interface ChatResponse {
  intent: ChatIntent;
  reply: string;
  suggestedFollowUps: string[];
  applied?: ApplyResponse;
}
