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

export type ComponentType =
  | 'heading'
  | 'text'
  | 'clock_display'
  | 'input'
  | 'select'
  | 'toggle'
  | 'slider'
  | 'button'
  | 'quiz_box'
  | 'status_banner';

export type ComponentSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type ComponentVariant = 'default' | 'primary' | 'danger' | 'warning' | 'success' | 'muted';

export interface ComponentStyle {
  size: ComponentSize;
  variant: ComponentVariant;
  align?: 'left' | 'center' | 'right';
  fullWidth?: boolean;
  noisyAnimation?: boolean;
}

export type BehaviorEffect =
  | 'none'
  | 'escape_on_hover'
  | 'require_3_clicks'
  | 'math_quiz_gate'
  | 'confirm_dialog'
  | 'play_alarm_sound'
  | 'tts_voice_alarm'
  | 'vibrate_shake';

export interface ComponentBehavior {
  effect: BehaviorEffect;
  quizQuestion?: string;
  quizAnswer?: string;
  confirmText?: string;
  voiceText?: string;
}

export type ActionType =
  | 'set_state'
  | 'toggle_state'
  | 'increment_state'
  | 'reset_all'
  | 'show_toast'
  | 'complete_task';

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

export interface AppComponent {
  id: string;
  type: ComponentType;
  label: string;
  placeholder?: string;
  options?: string[];
  stateKey?: string;
  style: ComponentStyle;
  behavior?: ComponentBehavior;
  visibleWhen?: VisibilityCondition;
  actions: ComponentAction[];
}

export interface AppTheme {
  bgColor: string;
  cardColor: string;
  textColor: string;
  accentColor: string;
  chaoticLayout: boolean;
}

export interface AppSpec {
  id: string;
  title: string;
  subtitle: string;
  taskDescription: string;
  theme: AppTheme;
  state: AppStateVar[];
  components: AppComponent[];
}

// 顧客層 (3層) と 9人のペルソナ＋制約変数 (企画書 2章: 層の中の3人と制約変数 / 選択9・10)
export type TargetCohortId = 'elderly' | 'office_worker' | 'student';

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
  environment: 'normal' | 'one_hand' | 'moving_train' | 'dark_room';
  /** 二度寝防止の仕掛け（クイズ・逃げるボタン・連打・声アラーム等）が必須か */
  requiresWakeGimmick?: boolean;
  /** TTS読み上げ時の声の高さ (0.5 - 1.5) */
  voicePitch: number;
  /** TTS読み上げ時の話す速さ (0.7 - 1.4) */
  voiceRate: number;
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

export interface ReviewerEvaluation {
  reviewerId: string;
  outcome: 'achieved' | 'abandoned';
  frictionPoint: string;
  comment: string;
  /** Computer Use 実操作シミュレーションの軌跡ログ */
  actionTrace?: string[];
  /** 適用された制約変数の要約 */
  appliedConstraintNote?: string;
}

export interface EvaluationResponse {
  evaluatedAt: string;
  source: 'gemini' | 'fallback';
  cohortId?: TargetCohortId;
  results: ReviewerEvaluation[];
}

// 人間の判断記録 (Own the Why / Function Calling で構造化記録)
export type DecisionStage = 'select_cohort' | 'select_tradeoff' | 'review_disposition';

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
  errors: string[];
}

// 壁打ち(選択肢提示) API の入出力
export interface TradeoffOption {
  id: string;
  title: string;
  summary: string;
  uiChange: string;
  logicChange: string;
  pros: string;
  tradeoff: string;
}

export interface ProposeRequest {
  currentSpec: AppSpec;
  targetComponentIds: string[];
  userInstruction: string;
  cohortId?: TargetCohortId;
  annotatedImageBase64?: string;
}

export interface ProposeResponse {
  source: 'gemini' | 'fallback';
  analysis: string;
  question: string;
  options: TradeoffOption[];
}

// 改修反映 API の入出力
export interface ApplyRequest {
  currentSpec: AppSpec;
  targetComponentIds: string[];
  userInstruction: string;
  selectedOption: TradeoffOption;
  selectionReason?: string;
  cohortId?: TargetCohortId;
  customNote?: string;
  annotatedImageBase64?: string;
}

export interface ApplyResponse {
  source: 'gemini' | 'fallback';
  commitMessage: string;
  changeHighlights: string[];
  updatedSpec: AppSpec;
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
  changeHighlights: string[];
  createdAt: string;
  spec: AppSpec;
  evaluation?: EvaluationResponse;
}

// 自由対話タイムライン型ハイブリッド壁打ち API
export type ChatIntent = 'explain' | 'direct_apply' | 'tradeoff_propose';

export interface InspectedComponentInfo {
  id: string;
  label: string;
  howItWorks: string;
  issueOrHint: string;
}

export interface ChatRequest {
  currentSpec: AppSpec;
  targetComponentIds: string[];
  userMessage: string;
  cohortId?: TargetCohortId;
  annotatedImageBase64?: string;
}

export interface ChatResponse {
  source: 'gemini' | 'fallback';
  intent: ChatIntent;
  reply: string;
  suggestedFollowUps: string[];
  inspectedComponents?: InspectedComponentInfo[];
  appliedResult?: {
    commitMessage: string;
    changeHighlights: string[];
    updatedSpec: AppSpec;
    validation?: SandboxValidationResult;
    rolledBack?: boolean;
  };
  options?: TradeoffOption[];
}
