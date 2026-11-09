// 題材（お題アプリ）の定義。題材を差し替えるときは ThemeDefinition を1つ書けばよい。

import type {
  AppComponent,
  AppSpec,
  AppStateVar,
  ReviewerPersona,
  TargetCohortInfo,
} from './types.ts';

/**
 * 初期画面に組み込む「使いにくさ」の1つ。
 * apply は初期画面（base を複製したもの）を直接書き換える。
 */
export interface AnnoyanceDefinition {
  id: string;
  /** 学習者には見せない、開発者向けの説明 */
  description: string;
  /**
   * always: 毎回必ず入れる（最初の改修で手応えが出るもの）
   * realistic: 実際の画面にもある使いにくさ
   * joke: 笑いどころ。現実味は薄いので少なめに出す
   */
  kind: 'always' | 'realistic' | 'joke';
  /** 抽選での出やすさ（既定 1）。小さいほど出にくい */
  weight?: number;
  /** 同じグループからは1回に1つまでしか選ばない（広告が2つ重なるのを防ぐなど） */
  exclusiveGroup?: string;
  apply: (spec: AppSpec) => void;
}

export type DifficultyLevel = 'easy' | 'normal' | 'hard';

/** 難しさごとに、各枠から選ぶ数の範囲 */
export interface LevelDefinition {
  realistic: { min: number; max: number };
  joke: { min: number; max: number };
}

/** 冒頭の会話の1行。owner や assistant の行は書き込み中の表示を挟んで話す */
export interface IntroLine {
  speaker: 'system' | 'owner' | 'assistant';
  text: string;
  /** この行の下に顧客層の選択肢を出す */
  showCohortSelector?: boolean;
}

/**
 * 店長が採点のたびに気にする数字。注文してくれた人のうち、stateKey の値が countWhen に当たる人を数える。
 * countWhen が filled なら、値が入っていれば数える。
 */
export interface OwnerMetric {
  label: string;
  stateKey: string;
  countWhen: true | 'filled';
  /** 改修でこの項目がなくなったときも店長が触れる */
  reportWhenMissing?: boolean;
}

/**
 * 店長のせりふ。{customers} は来たお客さんの数、{orders} は買ってくれた人数、
 * {label} は数字の名前（定期便など）、{count} はその件数、{metrics} は「定期便も1件」を並べたもの
 */
export interface OwnerLines {
  /** お客さんの反応を見たとき */
  noOrders: string;
  allOrdered: string;
  someOrdered: string;
  metricMissing: string;
  metricTaken: string;
  metricZero: string;
  /** 改造した直後 */
  completionFixed: string;
  metricRemoved: string;
  metricUnchecked: string;
  metricEnlarged: string;
  popupRemoved: string;
  distractionRemoved: string;
  confirmAdded: string;
  /** 選んだお客さん全員が満足したときの締め。数字が取れたときと取れなかったとき */
  closingWithMetrics: string[];
  closingWithoutMetrics: string[];
}

/** 依頼主の店長。お客さんとは別に、お店の売上の立場から反応する */
export interface OwnerDefinition {
  name: string;
  icon: string;
  metrics: OwnerMetric[];
  /** AIが店長のせりふを作るときの人物像と話し方 */
  voice: string;
  /** AIを使えないときの決まったせりふ。AIにも話し方の見本として渡す */
  lines: OwnerLines;
}

/** 固定の問題。妨害要素を名前で並べて、狙った対立を持つ画面を作る */
export interface ScenarioDefinition {
  title: string;
  /** 開発者向けの説明（どんな筋書きで、どこで対立が起きるか） */
  description: string;
  annoyanceIds: string[];
}

export interface ThemeDefinition {
  id: string;
  /** AIへの指示や進行役の発言で使う、題材アプリの呼び名（例: コーヒー豆の通販画面） */
  appName: string;
  /** お客さんが達成したいこと（例: コーヒー豆を注文する） */
  taskLabel: string;
  /** 体験の冒頭の会話 */
  introScript: IntroLine[];
  owner: OwnerDefinition;
  /** 固定の問題。体験は既定でこのうち defaultScenarioId の画面から始まる */
  scenarios: Record<string, ScenarioDefinition>;
  defaultScenarioId: string;
  /** 妨害要素を入れる前の画面 */
  baseSpec: AppSpec;
  annoyances: AnnoyanceDefinition[];
  levels: Record<DifficultyLevel, LevelDefinition>;
  cohorts: TargetCohortInfo[];
  personas: ReviewerPersona[];
  /** 顧客層が未選択のときにレビューする代表3人のID */
  defaultReviewerIds: string[];
  /** 実装AIへの補足（題材特有のルールや部品箱） */
  implementerNotes: string[];
  /**
   * お助けエージェントが質問に答えるときに使ってよい、画面の仕組みの事実（部品の仕様だけでは分からない動き）。
   * どこが悪いか・どう直すべきかは書かない
   */
  explainerNotes?: string[];
}

/** 再現できる乱数（mulberry32） */
export function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInRange(range: { min: number; max: number }, random: () => number): number {
  return range.min + Math.floor(random() * (range.max - range.min + 1));
}

/** 出やすさの重みに沿って重複なく選ぶ。同じグループはすでに選ばれていれば除く */
function pickWeighted(
  items: AnnoyanceDefinition[],
  count: number,
  random: () => number,
  usedGroups: Set<string>,
): AnnoyanceDefinition[] {
  const pool = [...items];
  const picked: AnnoyanceDefinition[] = [];
  while (picked.length < count) {
    const available = pool.filter((a) => !a.exclusiveGroup || !usedGroups.has(a.exclusiveGroup));
    if (available.length === 0) break;
    const total = available.reduce((sum, a) => sum + (a.weight ?? 1), 0);
    let r = random() * total;
    let chosen = available[available.length - 1];
    for (const a of available) {
      r -= a.weight ?? 1;
      if (r < 0) {
        chosen = a;
        break;
      }
    }
    picked.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
    if (chosen.exclusiveGroup) usedGroups.add(chosen.exclusiveGroup);
  }
  return picked;
}

export interface BuiltInitialSpec {
  spec: AppSpec;
  appliedAnnoyanceIds: string[];
}

/**
 * 題材の初期画面を作る。毎回必ず入れる妨害要素に加え、難しさに応じた数だけ
 * 「現実の使いにくさ」と「冗談」の枠からランダムに選んで組み込む。
 * 同じ seed と難しさなら同じ画面になる。
 */
export function buildInitialSpec(
  theme: ThemeDefinition,
  seed: number,
  level: DifficultyLevel = 'normal',
): BuiltInitialSpec {
  const random = createSeededRandom(seed);
  const spec = structuredClone(theme.baseSpec);
  const levelDef = theme.levels[level];
  const usedGroups = new Set<string>();

  const always = theme.annoyances.filter((a) => a.kind === 'always');
  const realistic = theme.annoyances.filter((a) => a.kind === 'realistic');
  const jokes = theme.annoyances.filter((a) => a.kind === 'joke');

  const selected = [
    ...always,
    ...pickWeighted(realistic, randomInRange(levelDef.realistic, random), random, usedGroups),
    ...pickWeighted(jokes, randomInRange(levelDef.joke, random), random, usedGroups),
  ];

  for (const annoyance of selected) {
    annoyance.apply(spec);
  }

  return { spec, appliedAnnoyanceIds: selected.map((a) => a.id) };
}

/** 固定の問題の画面を作る。妨害要素は題材の定義順に組み込む */
export function buildScenarioSpec(theme: ThemeDefinition, scenarioId: string): BuiltInitialSpec {
  const scenario = theme.scenarios[scenarioId];
  if (!scenario) throw new Error(`問題が見つかりません: ${scenarioId}`);
  const spec = structuredClone(theme.baseSpec);
  const selected = theme.annoyances.filter((a) => scenario.annoyanceIds.includes(a.id));
  const unknown = scenario.annoyanceIds.filter((id) => !selected.some((a) => a.id === id));
  if (unknown.length > 0) throw new Error(`妨害要素が見つかりません: ${unknown.join(', ')}`);
  for (const annoyance of selected) {
    annoyance.apply(spec);
  }
  return { spec, appliedAnnoyanceIds: selected.map((a) => a.id) };
}

// ============================================================================
// 妨害要素を書くための小さな道具
// ============================================================================

export function findComponent(spec: AppSpec, id: string): AppComponent {
  const comp = spec.components.find((c) => c.id === id);
  if (!comp) throw new Error(`部品が見つかりません: ${id}`);
  return comp;
}

export function insertBefore(spec: AppSpec, anchorId: string, comp: AppComponent): void {
  const idx = spec.components.findIndex((c) => c.id === anchorId);
  spec.components.splice(idx === -1 ? spec.components.length : idx, 0, comp);
}

export function insertAfter(spec: AppSpec, anchorId: string, comp: AppComponent): void {
  const idx = spec.components.findIndex((c) => c.id === anchorId);
  spec.components.splice(idx === -1 ? spec.components.length : idx + 1, 0, comp);
}

/** 状態変数を追加する。同じキーがあれば初期値を上書きする */
export function upsertState(spec: AppSpec, variable: AppStateVar): void {
  const existing = spec.state.find((s) => s.key === variable.key);
  if (existing) {
    existing.initialValue = variable.initialValue;
  } else {
    spec.state.push(variable);
  }
}
