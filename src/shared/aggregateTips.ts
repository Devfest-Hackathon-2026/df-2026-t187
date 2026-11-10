// みんなの集計を、数字の一覧ではなく3つのコツとして見せるための決まり。
// どの値を根拠のタグにするかはコードで決め、Gemini には見出しと本文の言い方だけを任せる。
// Gemini の文はコードで確かめ、決まりに外れたら1回だけ作り直させ、それでもだめならテンプレートの文にする。

import type {
  PublicAggregateArchetypeOutcome,
  PublicAggregateCohortStat,
  PublicAggregateComponentStat,
  PublicAggregateStats,
} from './promptTelemetry.ts';
import type { ThemeDefinition } from './theme.ts';
import type { PromptArchetype } from './types.ts';
import { describeComponentFunctionName } from './workSteps.ts';

/** ボックスの並び順。① 指示の出し方のコツ、② つまずきやすい所、③ 見落としやすい所 */
export const AGGREGATE_TIP_BOX_IDS = ['phrasing', 'stumbling', 'blindspot'] as const;
export type AggregateTipBoxId = (typeof AGGREGATE_TIP_BOX_IDS)[number];

/** ボックスの小見出し。画面と Gemini への説明の両方で使う */
export const AGGREGATE_TIP_BOX_CAPTIONS: Record<AggregateTipBoxId, string> = {
  phrasing: '指示の出し方のコツ',
  stumbling: 'つまずきやすい所',
  blindspot: '見落としやすい所',
};

/** Gemini に伝える、ボックスごとのねらい */
const BOX_AIMS: Record<AggregateTipBoxId, string> = {
  phrasing: 'どんな言い方の指示がうまくいきやすいか',
  stumbling: '多くの人が手こずる部品と、その向き合い方',
  blindspot: '直したつもりで、別の誰かを困らせやすい判断',
};

/**
 * どの区分の挑戦から作ったコツか。今は全体の1組だけ。
 * 客層ごとに切り替えるときは { kind: 'cohort', cohortId } を足し、集計の読み込みで絞り込む
 */
export type AggregateTipSegment = { kind: 'all' };
export const ALL_AGGREGATE_TIP_SEGMENT: AggregateTipSegment = { kind: 'all' };

export function aggregateTipSegmentKey(segment: AggregateTipSegment): string {
  return segment.kind;
}

/** 根拠のタグ。text は画面に出す短い言葉、title はマウスを乗せたときに出す件数などの補足 */
export interface AggregateTipTag {
  text: string;
  title: string;
}

/**
 * ready: コツを出せる
 * collecting: 挑戦の数が足りないので集計中と出す（Gemini は呼ばない）
 * unavailable: BigQuery の集計を読めなかった
 */
type AggregateTipStatus = 'ready' | 'collecting' | 'unavailable';

export interface AggregateTipBox {
  id: AggregateTipBoxId;
  status: AggregateTipStatus;
  heading?: string;
  body?: string;
  /** 見出しと本文を Gemini が書いたか、テンプレートの文か */
  source?: 'gemini' | 'template';
  tags: AggregateTipTag[];
  /** 集計中のとき、表示できるまでにあと何件の挑戦が要るか。分からないときは入れない */
  runsNeeded?: number;
}

export interface PublicAggregateTips {
  /** BigQuery の集計を読めたか */
  available: boolean;
  /** コツを作った時刻（ISO 8601） */
  generatedAt: string;
  segment: AggregateTipSegment;
  minRunsForDisplay: number;
  boxes: AggregateTipBox[];
}

/** コードで決めた、1つのボックスの材料 */
export interface AggregateTipBoxFacts {
  id: AggregateTipBoxId;
  status: AggregateTipStatus;
  runsNeeded?: number;
  /** 1ボックス3個まで。ready のときは1個以上 */
  tags: AggregateTipTag[];
  /** Gemini に渡す、タグの意味の説明。数字はタグに出ているものだけを書く */
  evidence: string[];
  /** Gemini を使えないときや、作り直してもだめだったときの文 */
  template: { heading: string; body: string };
}

/** 3件以上の公開の決まりとは別に、コツの根拠として使う区分に必要な最小件数 */
const MIN_TIP_EVIDENCE_COUNT = 5;
const MAX_TIP_TAGS = 3;
const MAX_TIP_HEADING_CHARS = 15;
const MAX_TIP_BODY_SENTENCES = 2;
const MAX_TIP_BODY_CHARS = 120;

// ============================================================================
// 部品の名前
// ============================================================================

/**
 * 題材の画面に出てくる部品のID → 役割の名前。
 * 集計では、ここにある部品だけを名前で出す。学習者やAIが作った部品のIDは出さない
 */
export function buildPublicComponentLabels(theme: ThemeDefinition): Map<string, string> {
  const labels = new Map<string, string>();
  for (const comp of theme.baseSpec.components) {
    labels.set(comp.id, describeComponentFunctionName(comp));
  }
  for (const annoyance of theme.annoyances) {
    const spec = structuredClone(theme.baseSpec);
    annoyance.apply(spec);
    for (const comp of spec.components) {
      if (!labels.has(comp.id)) labels.set(comp.id, describeComponentFunctionName(comp));
    }
  }
  return labels;
}

// ============================================================================
// タグと材料をコードで決める
// ============================================================================

function tipTargetCount(stats: PublicAggregateStats): number {
  return Math.max(stats.minRunsForDisplay, MIN_TIP_EVIDENCE_COUNT);
}

function expandSuppressedRunsNeeded(runsNeeded: number, stats: PublicAggregateStats): number {
  return runsNeeded + Math.max(0, tipTargetCount(stats) - stats.minRunsForDisplay);
}

function smallestTipRunsNeeded(
  items: ReadonlyArray<{
    suppressed: boolean;
    runsNeeded?: number;
    runCount?: number;
    executeCount?: number;
    executeRunCount?: number;
  }>,
  stats: PublicAggregateStats,
): number | undefined {
  const target = tipTargetCount(stats);
  const needs: number[] = [];
  for (const item of items) {
    if (item.suppressed) {
      if (item.runsNeeded !== undefined) {
        needs.push(expandSuppressedRunsNeeded(item.runsNeeded, stats));
      }
      continue;
    }
    const counts = [item.runCount, item.executeCount, item.executeRunCount].filter(
      (n): n is number => n !== undefined,
    );
    if (counts.length > 0) {
      needs.push(Math.max(1, ...counts.map((n) => target - n)));
    }
  }
  return needs.length > 0 ? Math.min(...needs) : undefined;
}

type ShownOutcome = PublicAggregateArchetypeOutcome & { redoneRatePercent: number; executeCount: number; runCount: number };
type ShownComponent = PublicAggregateComponentStat & { struggleRatePercent: number; runCount: number };
type ShownCohort = PublicAggregateCohortStat & { clearRatePercent: number; runCount: number; executeRunCount: number };

const PHRASING_HEADINGS: Partial<Record<PromptArchetype, string>> = {
  goal_directed: '目的から伝えてみる',
  condition_design: '条件まで言葉にする',
  direct_fix: '直す所を具体的に言う',
};

const PHRASING_ADVICE: Partial<Record<PromptArchetype, string>> = {
  goal_directed: '何のために直すのかを先に伝えた人ほど、少ない手直しで進めています。',
  condition_design: 'どんなときにどうなってほしいかまで伝えた人ほど、少ない手直しで進めています。',
  direct_fix: 'どの部品をどう変えたいかをはっきり伝えた人ほど、少ない手直しで進めています。',
};

function buildPhrasingFacts(stats: PublicAggregateStats): AggregateTipBoxFacts {
  const target = tipTargetCount(stats);
  const shown = (stats.archetypeOutcomes ?? [])
    .filter(
      (o): o is ShownOutcome =>
        !o.suppressed &&
        o.redoneRatePercent !== undefined &&
        (o.runCount ?? 0) >= target &&
        (o.executeCount ?? 0) >= target,
    )
    .sort(
      (a, b) =>
        a.redoneRatePercent - b.redoneRatePercent || b.executeCount - a.executeCount,
    );
  if (shown.length === 0) {
    return {
      id: 'phrasing',
      status: 'collecting',
      runsNeeded: smallestTipRunsNeeded(stats.archetypeOutcomes ?? [], stats),
      tags: [],
      evidence: [],
      template: { heading: '', body: '' },
    };
  }
  const best = shown[0];
  const worstCandidate = shown[shown.length - 1];
  const worst =
    worstCandidate !== best && worstCandidate.redoneRatePercent > best.redoneRatePercent
      ? worstCandidate
      : undefined;

  const tags: AggregateTipTag[] = [];
  const evidence: string[] = [];
  const outcomeTag = (o: ShownOutcome): AggregateTipTag => ({
    text: `${o.label} やり直し${o.redoneRatePercent}%`,
    title: `${o.label}${o.executeCount}件のうち、直した部品をあとでもう一度直した割合。${o.runCount}件の挑戦から`,
  });
  tags.push(outcomeTag(best));
  evidence.push(
    `${tags[0].text}：${best.label}のうち、直した部品を同じ挑戦の中であとからもう一度直すことになった割合です。${worst ? 'ほかの型より低めです。' : ''}`,
  );
  if (worst) {
    const tag = outcomeTag(worst);
    tags.push(tag);
    evidence.push(`${tag.text}：同じ割合で、ほかの型より高めです。`);
  }

  const heading = PHRASING_HEADINGS[best.archetype] ?? '一か所ずつ確かめて直す';
  const advice = PHRASING_ADVICE[best.archetype] ?? '一か所ずつ結果を確かめながら進めた人が多いようです。';
  const first = worst
    ? `${best.label}は、あとで同じ部品を直し直した割合が${best.redoneRatePercent}%で、${worst.label}の${worst.redoneRatePercent}%より低めでした。`
    : `${best.label}は、あとで同じ部品を直し直した割合が${best.redoneRatePercent}%でした。`;
  return {
    id: 'phrasing',
    status: 'ready',
    tags,
    evidence,
    template: { heading, body: `${first}${advice}` },
  };
}

function buildStumblingFacts(stats: PublicAggregateStats): AggregateTipBoxFacts {
  const target = tipTargetCount(stats);
  const shown = (stats.componentStats ?? [])
    .filter(
      (c): c is ShownComponent =>
        !c.suppressed &&
        c.struggleRatePercent !== undefined &&
        (c.runCount ?? 0) >= target,
    )
    .sort((a, b) => b.struggleRatePercent - a.struggleRatePercent || b.runCount - a.runCount)
    .slice(0, 2);
  const topEntity =
    (stats.totalRuns ?? 0) >= target
      ? stats.topEntities?.find((e) => e.count >= target)
      : undefined;

  if (shown.length === 0 && !topEntity) {
    return {
      id: 'stumbling',
      status: 'collecting',
      runsNeeded: smallestTipRunsNeeded(stats.componentStats ?? [], stats),
      tags: [],
      evidence: [],
      template: { heading: '', body: '' },
    };
  }

  const tags: AggregateTipTag[] = [];
  const evidence: string[] = [];
  for (const c of shown) {
    const tag: AggregateTipTag = {
      text: `${c.label} 何度も直した${c.struggleRatePercent}%`,
      title: `${c.label}を直した${c.runCount}件の挑戦のうち、同じ挑戦の中で2回以上直した割合`,
    };
    tags.push(tag);
    evidence.push(`${tag.text}：${c.label}を直した挑戦のうち、同じ挑戦の中で何度も直すことになった割合です。`);
  }
  if (topEntity && tags.length < MAX_TIP_TAGS) {
    const tag: AggregateTipTag = {
      text: `話題の多い言葉 ${topEntity.term}`,
      title: `指示や質問の中で${topEntity.count}回話題になりました`,
    };
    tags.push(tag);
    evidence.push(`${tag.text}：指示や質問の中で、よく話題になった言葉です。`);
  }

  const top = shown[0];
  const body = top
    ? `${top.label}は、直した挑戦のうち${top.struggleRatePercent}%で何度か直し直しがありました。手こずったら、店長やお客さんに困りごとを聞いてから直すのも一つの手です。`
    : `${topEntity?.term ?? ''}はよく話題になった言葉です。直す前に、誰がなぜ困っているのかを確かめてみるのも一つの手です。`;
  return {
    id: 'stumbling',
    status: 'ready',
    tags,
    evidence,
    template: { heading: '迷ったら先に聞いてみる', body },
  };
}

function buildBlindspotFacts(stats: PublicAggregateStats): AggregateTipBoxFacts {
  const target = tipTargetCount(stats);
  const cohorts = stats.cohorts
    .filter(
      (c): c is ShownCohort =>
        !c.suppressed &&
        c.clearRatePercent !== undefined &&
        (c.runCount ?? 0) >= target &&
        (c.executeRunCount ?? 0) >= target,
    )
    .sort(
      (a, b) =>
        a.clearRatePercent - b.clearRatePercent ||
        b.executeRunCount - a.executeRunCount ||
        b.runCount - a.runCount,
    );
  const removed =
    (stats.totalRuns ?? 0) >= target &&
    (stats.executeRunCount ?? 0) >= target &&
    (stats.executePrompts ?? 0) >= target
      ? stats.removedNeededFeatureRatePercent
      : undefined;

  if (removed === undefined && cohorts.length === 0) {
    const cohortNeeds = smallestTipRunsNeeded(stats.cohorts, stats);
    const overallExecuteNeed =
      stats.executeRunCount !== undefined
        ? Math.max(1, target - stats.executeRunCount, target - (stats.executePrompts ?? 0))
        : undefined;
    const runsNeeded =
      cohortNeeds !== undefined && overallExecuteNeed !== undefined
        ? Math.min(cohortNeeds, overallExecuteNeed)
        : (cohortNeeds ?? overallExecuteNeed);
    return {
      id: 'blindspot',
      status: 'collecting',
      runsNeeded,
      tags: [],
      evidence: [],
      template: { heading: '', body: '' },
    };
  }

  const tags: AggregateTipTag[] = [];
  const evidence: string[] = [];
  if (removed !== undefined) {
    const tag: AggregateTipTag = {
      text: `必要な機能を消した指示 ${removed}%`,
      title: `手直しの指示のうち、お客さんに必要な機能まで消してしまった割合。${stats.totalRuns ?? 0}件の挑戦から`,
    };
    tags.push(tag);
    evidence.push(`${tag.text}：手直しの指示のうち、ほかのお客さんが使う機能まで消してしまった割合です。`);
  }
  const lowest = cohorts[0];
  const highestCandidate = cohorts[cohorts.length - 1];
  const highest =
    highestCandidate && highestCandidate !== lowest && highestCandidate.clearRatePercent > lowest.clearRatePercent
      ? highestCandidate
      : undefined;
  const cohortTag = (c: ShownCohort): AggregateTipTag => ({
    text: `${c.label} クリア${c.clearRatePercent}%`,
    title: `${c.label}を選んで1回以上手直しした${c.executeRunCount}件の挑戦のうち、クリアした割合`,
  });
  if (lowest && tags.length < MAX_TIP_TAGS) {
    const tag = cohortTag(lowest);
    tags.push(tag);
    evidence.push(
      `${tag.text}：この客層を選んで手直しした挑戦のうちクリアした割合です。${highest ? '客層の中でいちばん低めです。' : ''}`,
    );
  }
  if (highest && tags.length < MAX_TIP_TAGS) {
    const tag = cohortTag(highest);
    tags.push(tag);
    evidence.push(`${tag.text}：同じ割合で、客層の中でいちばん高めです。`);
  }

  const body =
    removed !== undefined
      ? `必要な機能まで消してしまった指示が${removed}%ありました。消す前に、その機能を頼りにしているお客さんがいないか確かめてみるとよさそうです。`
      : `${lowest.label}はクリア${lowest.clearRatePercent}%でした。直したあとに、ほかのお客さんが困っていないかも見てみるとよさそうです。`;
  return {
    id: 'blindspot',
    status: 'ready',
    tags,
    evidence,
    template: { heading: '消す前に誰が使うか考える', body },
  };
}

/**
 * 公開してよい集計値から、3つのボックスの材料を決める。
 * 全体の挑戦が足りないときや、そのボックスの根拠になる区分がどれも足りないときは collecting にする
 */
export function buildAggregateTipFacts(stats: PublicAggregateStats): AggregateTipBoxFacts[] {
  if (!stats.available) {
    return AGGREGATE_TIP_BOX_IDS.map((id) => ({
      id,
      status: 'unavailable' as const,
      tags: [],
      evidence: [],
      template: { heading: '', body: '' },
    }));
  }
  if (stats.suppressed) {
    const runsNeeded =
      stats.runsNeeded !== undefined ? expandSuppressedRunsNeeded(stats.runsNeeded, stats) : undefined;
    return AGGREGATE_TIP_BOX_IDS.map((id) => ({
      id,
      status: 'collecting' as const,
      runsNeeded,
      tags: [],
      evidence: [],
      template: { heading: '', body: '' },
    }));
  }
  return [buildPhrasingFacts(stats), buildStumblingFacts(stats), buildBlindspotFacts(stats)].map((facts) => ({
    ...facts,
    tags: facts.tags.slice(0, MAX_TIP_TAGS),
    evidence: facts.evidence.slice(0, MAX_TIP_TAGS),
  }));
}

// ============================================================================
// Gemini の文を確かめる
// ============================================================================

/** 丸カッコ・かぎ括弧・二重かぎ括弧・すみ付き括弧・角括弧・波括弧・山括弧など。全角も半角も */
const TIP_BRACKET_RE = /[()（）「」『』【】\[\]［］{}｛｝〈〉《》〔〕〖〗〘〙〚〛｢｣<>＜＞⦅⦆«»‹›]/;

/** 漢数字で書いた割合や件数。三割、五件など */
const KANJI_NUMBER_RE = /[〇一二三四五六七八九十百千]+(?:割|パーセント|件|倍|％|%)/;

/** 言い切り。必ずしも、は言い切りではないので外す */
const ASSERTIVE_RE = /必ず(?!しも)|絶対/;

/** 画面の具体的な直し方（答えそのもの）に踏み込んでいる表現 */
const SPOILER_RE =
  /バナー|閉じるボタン|[×✕]ボタン|バツボタン|チェックを(?:外|はず)|最初から(?:オフ|OFF|外)|初期状態|未選択に|任意で選|確認画面|確認ダイアログ|ワンクッション|(?:文字|字|サイズ|ボタン)を大きく|押しやすく|算用数字|アラビア数字|送料を(?:含め|足|合算)|解約条件|電話のみ/i;

function toHalfWidthDigits(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.');
}

/** 文中のアラビア数字を取り出す。全角の数字も半角にそろえる */
export function extractNumbers(text: string): string[] {
  return toHalfWidthDigits(text).match(/\d+(?:\.\d+)?/g) ?? [];
}

export function containsTipBracket(text: string): boolean {
  return TIP_BRACKET_RE.test(text);
}

function countTipChars(text: string): number {
  return [...text].length;
}

export function splitTipSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 空白をそろえ、見出しの最後の句点を取る */
export function normalizeTipDraft(draft: { heading?: unknown; body?: unknown }): { heading: string; body: string } {
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  return {
    heading: clean(draft.heading).replace(/[。．.]+$/u, ''),
    body: clean(draft.body),
  };
}

/**
 * 見出しと本文が決まりに合っているかを確かめ、外れている点を返す（合っていれば空の配列）。
 * 返す言葉は、作り直しのときにそのまま Gemini に伝える
 */
export function findTipRuleViolations(
  draft: { heading: string; body: string },
  tags: ReadonlyArray<AggregateTipTag>,
): string[] {
  const violations: string[] = [];
  const { heading, body } = draft;
  if (!heading) violations.push('見出しが空です。');
  if (!body) violations.push('本文が空です。');
  if (containsTipBracket(heading) || containsTipBracket(body)) {
    violations.push('括弧が使われています。括弧は全角も半角も一切使わないでください。');
  }
  if (countTipChars(heading) > MAX_TIP_HEADING_CHARS) {
    violations.push(`見出しが${MAX_TIP_HEADING_CHARS}文字を超えています。もっと短い一言にしてください。`);
  }
  if (heading.includes('。')) {
    violations.push('見出しに句点が入っています。');
  }
  if (splitTipSentences(body).length > MAX_TIP_BODY_SENTENCES) {
    violations.push(`本文が${MAX_TIP_BODY_SENTENCES}文を超えています。`);
  }
  if (countTipChars(body) > MAX_TIP_BODY_CHARS) {
    violations.push('本文が長すぎます。80文字程度にしてください。');
  }
  if (ASSERTIVE_RE.test(heading) || ASSERTIVE_RE.test(body)) {
    violations.push('言い切りの表現があります。傾向として書いてください。');
  }
  if (SPOILER_RE.test(heading) || SPOILER_RE.test(body)) {
    violations.push(
      '画面の具体的な直し方に踏み込んでいます。どう変えるかの答えは書かず、誰に話を聞くかやどう確かめるかといった進め方の助言にしてください。',
    );
  }
  const allowed = new Set(tags.flatMap((t) => extractNumbers(t.text)));
  const stray = [...new Set([...extractNumbers(heading), ...extractNumbers(body)])].filter((n) => !allowed.has(n));
  if (stray.length > 0) {
    violations.push(`根拠にない数字 ${stray.join('、')} が入っています。数字は根拠のタグにあるものだけを使ってください。`);
  }
  if (KANJI_NUMBER_RE.test(heading) || KANJI_NUMBER_RE.test(body)) {
    violations.push('漢数字で割合や件数が書かれています。数字は根拠のタグにあるものだけを使ってください。');
  }
  return violations;
}

// ============================================================================
// Gemini への頼み方と、作り直し
// ============================================================================

export interface AggregateTipDraftRequest {
  boxes: AggregateTipBoxFacts[];
  /** 作り直しのとき、ボックスごとの前回の問題点 */
  feedback: Partial<Record<AggregateTipBoxId, string[]>>;
}

export type AggregateTipDrafts = Partial<Record<AggregateTipBoxId, { heading?: unknown; body?: unknown }>>;

/** 見出しと本文の案を作る関数。Gemini を呼ぶものを gemini.ts から渡す。使えないときは null を返す */
export type AggregateTipDrafter = (request: AggregateTipDraftRequest) => Promise<AggregateTipDrafts | null>;

/** Gemini に渡すプロンプト。根拠はコードで決めたタグと、その意味の説明だけ */
export function buildAggregateTipsPrompt(request: AggregateTipDraftRequest): string {
  const lines = [
    'あなたは、注文画面の手直しを練習する学習者に向けて、みんなの挑戦の集計からコツを伝える案内役です。やわらかい です・ます調で書きます。',
    '集計はコードで済ませてあります。下の根拠だけをもとに、ボックスごとに見出しと本文を1組ずつ作ってください。',
  ];
  for (const box of request.boxes) {
    lines.push('', `【ボックス ${box.id}：${AGGREGATE_TIP_BOX_CAPTIONS[box.id]}】`, `ねらい：${BOX_AIMS[box.id]}`, '根拠：');
    lines.push(...box.evidence.map((e) => `- ${e}`));
    const problems = request.feedback[box.id];
    if (problems && problems.length > 0) {
      lines.push('前回の案はここが決まりに外れていたので、直して作り直してください：');
      lines.push(...problems.map((p) => `- ${p}`));
    }
  }
  lines.push(
    '',
    '【決まり】',
    '1. 見出しと本文には括弧を一切使わないでください。丸カッコ、かぎ括弧、二重かぎ括弧、すみ付き括弧、角括弧、波括弧、山括弧など、全角も半角もすべて使いません。語を強調する記号も使いません。',
    `2. 見出しは、学習者が次に試せることを${MAX_TIP_HEADING_CHARS}文字以内の短い一言にし、句点を付けないでください。`,
    `3. 本文は${MAX_TIP_BODY_SENTENCES}文以内、80文字程度にしてください。1文目で集計から見える傾向を、2文目で次に試せる進め方や考え方を書きます。〜すると必ず、のように言い切らず、〜した人が多い、〜な傾向がある、のように傾向として書いてください。`,
    '4. 根拠の数字は本文の下にタグで出すので、本文で並べ直さなくてよいです。使うときは1つまでにし、根拠の各行の先頭にあるタグの数字だけを使ってください。ほかの数字や、件数、人数、回数は書かないでください。漢数字で数を書くのも避けてください。',
    '5. 画面の直し方の答えそのもの、たとえばバナーに変える・チェックを外す・確認画面を足す・文字やボタンを大きくするといった具体的な変更方法は書かず、誰に話を聞くかやどう確かめるかといった進め方・考え方の助言にとどめてください。',
    '6. 学習者の発言の中身や、個人を思わせることは書かないでください。',
  );
  return lines.join('\n');
}

/**
 * 3つのボックスを仕上げる。
 * ready のボックスだけ Gemini に頼み、決まりに外れた案は1回だけ作り直させる。それでもだめならテンプレートの文にする。
 * previous に同じタグのボックスがあり、Gemini の文が決まりに合っていれば、その文を使い回して Gemini を呼ばない
 */
export async function composeAggregateTips(
  facts: ReadonlyArray<AggregateTipBoxFacts>,
  drafter: AggregateTipDrafter | null,
  options: { previous?: ReadonlyArray<AggregateTipBox> } = {},
): Promise<AggregateTipBox[]> {
  const written = new Map<AggregateTipBoxId, { heading: string; body: string }>();
  const sameTags = (a: ReadonlyArray<AggregateTipTag>, b: ReadonlyArray<AggregateTipTag>) =>
    a.length === b.length && a.every((t, i) => t.text === b[i].text);

  let pending: AggregateTipBoxFacts[] = [];
  for (const box of facts) {
    if (box.status !== 'ready') continue;
    const prev = options.previous?.find((p) => p.id === box.id);
    if (prev?.status === 'ready' && prev.source === 'gemini' && sameTags(prev.tags, box.tags)) {
      const reused = normalizeTipDraft(prev);
      if (findTipRuleViolations(reused, box.tags).length === 0) {
        written.set(box.id, reused);
        continue;
      }
    }
    pending.push(box);
  }

  const feedback: Partial<Record<AggregateTipBoxId, string[]>> = {};
  for (let attempt = 0; attempt < 2 && pending.length > 0 && drafter; attempt++) {
    let drafts: AggregateTipDrafts | null;
    try {
      drafts = await drafter({ boxes: pending, feedback: { ...feedback } });
    } catch {
      drafts = null;
    }
    if (!drafts) break;
    const retry: AggregateTipBoxFacts[] = [];
    for (const box of pending) {
      const raw = drafts[box.id];
      const draft = normalizeTipDraft(raw ?? {});
      const violations = raw ? findTipRuleViolations(draft, box.tags) : ['このボックスの案がありませんでした。'];
      if (violations.length === 0) {
        written.set(box.id, draft);
      } else {
        feedback[box.id] = violations;
        retry.push(box);
      }
    }
    pending = retry;
  }

  return facts.map((box): AggregateTipBox => {
    if (box.status !== 'ready') {
      return {
        id: box.id,
        status: box.status,
        tags: [],
        ...(box.runsNeeded !== undefined ? { runsNeeded: box.runsNeeded } : {}),
      };
    }
    const text = written.get(box.id);
    return {
      id: box.id,
      status: 'ready',
      heading: text?.heading ?? box.template.heading,
      body: text?.body ?? box.template.body,
      source: text ? 'gemini' : 'template',
      tags: box.tags,
    };
  });
}

// ============================================================================
// 保存したコツの読み戻し
// ============================================================================

const TIP_STATUSES: ReadonlyArray<AggregateTipStatus> = ['ready', 'collecting', 'unavailable'];

function isTipTag(value: unknown): value is AggregateTipTag {
  const v = value as AggregateTipTag;
  return Boolean(v) && typeof v.text === 'string' && typeof v.title === 'string' && v.text.length <= 60 && v.title.length <= 200;
}

function isTipBox(value: unknown, id: AggregateTipBoxId): value is AggregateTipBox {
  const v = value as AggregateTipBox;
  if (!v || v.id !== id || !TIP_STATUSES.includes(v.status)) return false;
  if (!Array.isArray(v.tags) || v.tags.length > MAX_TIP_TAGS || !v.tags.every(isTipTag)) return false;
  if (v.runsNeeded !== undefined && !(Number.isInteger(v.runsNeeded) && v.runsNeeded > 0)) return false;
  if (v.status !== 'ready') return true;
  return (
    typeof v.heading === 'string' &&
    typeof v.body === 'string' &&
    (v.source === 'gemini' || v.source === 'template') &&
    findTipRuleViolations({ heading: v.heading, body: v.body }, v.tags).length === 0
  );
}

/** Cloud Firestore から読み戻したコツが、決まった形と決まりに合っているか */
export function isPublicAggregateTips(value: unknown): value is PublicAggregateTips {
  const v = value as PublicAggregateTips;
  return (
    Boolean(v) &&
    typeof v.available === 'boolean' &&
    typeof v.generatedAt === 'string' &&
    !Number.isNaN(Date.parse(v.generatedAt)) &&
    v.segment?.kind === 'all' &&
    Number.isInteger(v.minRunsForDisplay) &&
    Array.isArray(v.boxes) &&
    v.boxes.length === AGGREGATE_TIP_BOX_IDS.length &&
    AGGREGATE_TIP_BOX_IDS.every((id, i) => isTipBox(v.boxes[i], id))
  );
}
