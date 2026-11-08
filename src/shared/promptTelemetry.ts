// プロンプト・テレメトリ分析と行動ベースの到達効率集計
// 主指標はLLMの主観採点ではなく、探索と実行を分離した行動データ（初回到達率・往復数・手戻り有無）に置く。

import type { AppSpec, OwnerReport, SpecPatch, TargetCohortId } from './types.ts';

/**
 * セッション内の発言の目的タイプ。
 * - explore: 店長やお客さんへの質問・お助けAIへの相談（往復そのものが情報収集なので実行往復数の分母に数えない）
 * - execute: 画面を手直しする実行指示
 */
export type PromptSessionMode = 'explore' | 'execute';

/**
 * 指示の型（クラスタ分類）。
 * - simple_delete: 定期便・クーポン・広告などを条件を考えず単純に消す指示
 * - condition_design: 初期チェック解除・解約条件明記・閉じるボタン改善など条件を整える指示
 * - direct_fix: ボタンの動作修復・文字サイズ変更・表記変更など具体的な部品修正指示
 * - vague_delegate: いい感じにして・直して など対象や条件が曖昧な丸投げ指示
 * - goal_directed: 定期便を望む人だけが選べるように など、誰がどうできるようにしたいかという目的を言葉にした指示（直し方はAIに任せてもよい）
 * - inquiry: 質問・聞き出し
 */
export type PromptArchetype =
  | 'goal_directed'
  | 'simple_delete'
  | 'condition_design'
  | 'direct_fix'
  | 'vague_delegate'
  | 'inquiry';

/** Cloud Natural Language API（またはローカル決定論抽出）による一次特徴 */
export interface NaturalLanguageSignal {
  /** 抽出された対象部品・概念エンティティ */
  entities: string[];
  /** 条件指定（どう変えるか・どういう状態にするか）が含まれているか */
  hasConditionConstraint: boolean;
  /** 感情極性スコア (-1.0 〜 1.0) */
  sentimentScore: number;
  /** 解析経路 */
  analyzedVia: 'cloud_natural_language_api' | 'local_deterministic';
}

/** Gemini Enterprise Agent Platform の埋め込み（またはローカル決定論類似度）による構造化クラスタ分類 */
export interface EmbeddingSignal {
  closestArchetype: PromptArchetype;
  similarityScore: number;
  analyzedVia: 'agent_platform_embedding' | 'local_deterministic';
}

/** 1回の発言・指示に対するテレメトリ記録 */
export interface PromptTelemetryEvent {
  id: string;
  cohortId?: TargetCohortId;
  /** 1回の挑戦ごとの番号 */
  runId?: string;
  /**
   * その挑戦の中で何番目の発言か。指示の本文はサーバーにもクラウドにも残さず、学習者のブラウザだけが持つ。
   * 振り返りで指示を引用するときは、この番号を目印にブラウザが手元の本文を差し込む
   */
  turnIndex: number;
  sessionMode: PromptSessionMode;
  recipient: string;
  hasPenAnnotation: boolean;
  changedComponentIds: string[];
  /** 実行型指示で、直前までに変更した部品を再び手直ししたか（手戻り・否定型修正） */
  isReworkOnSameComponent: boolean;
  /** 単純削除によって客の希望（定期便・クーポン等）や店舗指標を損ねた指示か */
  removedNeededFeature: boolean;
  nlSignal: NaturalLanguageSignal;
  embeddingSignal: EmbeddingSignal;
  outcomeAfterTurn?: {
    achievedCount: number;
    totalCustomers: number;
    passed: boolean;
  };
  createdAt: string;
}

/** ステージクリア時（またはふりかえり時）に出す行動ベースの集計サマリー */
export interface PromptSessionSummary {
  cohortId?: TargetCohortId;
  /** 探索型（質問・相談）の回数 */
  exploreTurns: number;
  /** 実行型（手直し指示）の回数 */
  executeTurns: number;
  /** 同じ部品への手戻り・やり直し回数 */
  reworkTurns: number;
  /** 誰がどうできるようにしたいかという目的を言葉にした手直し指示の回数 */
  goalDirectedTurns: number;
  /** 初回成功率（0〜100: 手戻りや機能喪失にならず意図通り機能した実行指示の割合） */
  firstShotSuccessRate: number;
  /** 単純削除や丸投げから条件指定へ改善した転換点。何番目の発言かで示す */
  turningPoint?: {
    beforeTurn: number;
    afterTurn: number;
  };
  /** クリアに貢献した代表的な発言が何番目か */
  effectiveTurn?: number;
  /**
   * チャットのシステムメッセージ行にする振り返り文（括弧なし・インラインコード付き）。
   * 指示の引用は turnRef の目印になっていて、ブラウザが fillTurnRefs で本文に置き換える
   */
  systemLogLines: string[];
  /**
   * クリア時にお助けAIが話す3つの振り返り吹き出し（1: 概要、2: よかった点、3: もっと良くなる点）。
   * 指示の引用は turnRef の目印になっていて、ブラウザが fillTurnRefs で本文に置き換える
   */
  assistantFeedbackLines?: string[];
}

export interface ClearFeedbackInput {
  cohortLabel: string;
  summary: PromptSessionSummary;
  owner: OwnerReport;
  otherCohorts: {
    achieved: number;
    total: number;
    unhappy: Array<{ name: string; reason: string }>;
  };
  /** クーポンが店にあったか、最終画面で割引として使える状態か */
  couponStatus?: 'usable_discount' | 'kept_no_discount' | 'removed' | 'none';
}

export interface ClearFeedbackFacts {
  overviewFacts: string[];
  goodPointFacts: string[];
  improvementFacts: string[];
  /** AIが使えないときや失敗したときにそのままお助けAIの3つの吹き出しとして出す文 */
  fallbackLines: [string, string, string];
}

const UI_ENTITY_TERMS = [
  '注文ボタン',
  '購入ボタン',
  'ボタン',
  '定期便',
  'おトク定期便',
  'チェック',
  'クーポン',
  '割引',
  '広告',
  'ポップアップ',
  'バナー',
  '閉じるボタン',
  'カウントダウン',
  '残り時間',
  'タイマー',
  '合計金額',
  '金額',
  '漢数字',
  '数字',
  '送料',
  '代引き手数料',
  '手数料',
  '確認画面',
  '確認ダイアログ',
  '確認',
  '解約条件',
  '注意書き',
  '文字',
  'サイズ',
  '大きさ',
  '色',
  '見出し',
  'おとり',
  'リセット',
];

const SIMPLE_DELETE_RE =
  /(?:定期|クーポン|広告|ポップアップ|カウントダウン|タイマー|項目|欄|バナー).*?(?:消して|削除して|なくして|外して消して|取り除いて|非表示にして)|^(?:消して|削除して|なくして)[！!。]*$/;

const CONDITION_DESIGN_RE =
  /(?:チェック.*?(?:外|はず|オフ|任意|選べ)|初期.*?(?:外|オフ|false)|解約|条件|いつでも|明記|書き添え|説明.*?(?:足|書|添)|閉じる.*?(?:大きく|下|左|右|押しやすく|バナー)|バナー.*?(?:変|直)|確認.*?(?:出|入|足|ダイアログ)|選べ(?:るように|る形)|使えるように|分かりやすく.*?残)/;

const VAGUE_DELEGATE_RE =
  /^(?:いい感じに|うまく|適当に|なんとか|全部|まとめて|とりあえず|おまかせで|きれいに|使いやすく|見やすく|買いやすく)(?:直して|して|変えて|手直しして|改造して)?[！!。？?]*$/;

/** 誰が（人・お客さん）どうできるようにしたいか、という目的の言い方 */
const GOAL_DIRECTED_RE =
  /(?:人|方|お客さん|客|誰|高齢|お年寄り|初めて)(?:が|でも|だけ|も|に|は)[^。]*?(?:ように|やすく|られる|できる|迷わ|安心)/;

const NEGATIVE_SENTIMENT_TERMS = ['邪魔', 'ウザい', 'だます', '騙す', '罠', '最悪', 'ひどい', '消せ', '紛らわしい'];
const POSITIVE_SENTIMENT_TERMS = ['安心', '親切', '見やすい', 'わかりやすい', '分かりやすい', '正直', '丁寧', '気持ちよく'];

/**
 * 発言から対象エンティティ・条件指定の有無・感情スコアを決定論的に抽出する。
 * Cloud Natural Language API が有効な場合はそのレスポンスと統合し、未設定時は単体で動作する。
 */
export function extractDeterministicNlSignal(promptText: string): NaturalLanguageSignal {
  const text = promptText.trim();
  const entities: string[] = [];
  for (const term of UI_ENTITY_TERMS) {
    if (text.includes(term) && !entities.some((e) => e.includes(term) || term.includes(e))) {
      entities.push(term);
    }
  }

  const hasConditionConstraint =
    CONDITION_DESIGN_RE.test(text) ||
    (entities.length >= 2 && /(?:を|の).*?(?:に|へ|よう)/.test(text) && !SIMPLE_DELETE_RE.test(text));

  let sentiment = 0;
  for (const neg of NEGATIVE_SENTIMENT_TERMS) {
    if (text.includes(neg)) sentiment -= 0.35;
  }
  for (const pos of POSITIVE_SENTIMENT_TERMS) {
    if (text.includes(pos)) sentiment += 0.35;
  }
  const sentimentScore = Math.max(-1, Math.min(1, Number(sentiment.toFixed(2))));

  return {
    entities,
    hasConditionConstraint,
    sentimentScore,
    analyzedVia: 'local_deterministic',
  };
}

/**
 * 発言がどの指示アーキタイプ（型）に属するかを決定論的に分類する。
 */
export function classifyDeterministicArchetype(
  promptText: string,
  sessionMode: PromptSessionMode,
): EmbeddingSignal {
  const text = promptText.trim();
  if (sessionMode === 'explore') {
    return {
      closestArchetype: 'inquiry',
      similarityScore: 0.92,
      analyzedVia: 'local_deterministic',
    };
  }
  if (VAGUE_DELEGATE_RE.test(text)) {
    return {
      closestArchetype: 'vague_delegate',
      similarityScore: 0.88,
      analyzedVia: 'local_deterministic',
    };
  }
  if (GOAL_DIRECTED_RE.test(text)) {
    return {
      closestArchetype: 'goal_directed',
      similarityScore: 0.9,
      analyzedVia: 'local_deterministic',
    };
  }
  if (CONDITION_DESIGN_RE.test(text)) {
    return {
      closestArchetype: 'condition_design',
      similarityScore: 0.91,
      analyzedVia: 'local_deterministic',
    };
  }
  if (SIMPLE_DELETE_RE.test(text)) {
    return {
      closestArchetype: 'simple_delete',
      similarityScore: 0.9,
      analyzedVia: 'local_deterministic',
    };
  }
  return {
    closestArchetype: 'direct_fix',
    similarityScore: 0.84,
    analyzedVia: 'local_deterministic',
  };
}

/**
 * 2つの数値ベクトル間のコサイン類似度を計算する（Agent Platform の埋め込み用）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Number((dot / denom).toFixed(4));
}

/**
 * 適用されたパッチと前後Specから、変更された部品ID一覧と「客が必要とする機能（定期便・クーポン）を単純削除したか」を判定する。
 */
export function inspectAppliedChangeForTelemetry(
  beforeSpec: AppSpec,
  afterSpec: AppSpec,
  patches: SpecPatch[] = [],
): { changedComponentIds: string[]; removedNeededFeature: boolean } {
  const changedIds = new Set<string>();
  for (const patch of patches) {
    if (patch.op === 'remove_component' || patch.op === 'move_component') {
      changedIds.add(patch.id);
    } else if (patch.op === 'replace_component' || patch.op === 'insert_component') {
      changedIds.add(patch.component.id);
    }
  }

  if (changedIds.size === 0) {
    const beforeMap = new Map(beforeSpec.components.map((c) => [c.id, JSON.stringify(c)]));
    const afterMap = new Map(afterSpec.components.map((c) => [c.id, JSON.stringify(c)]));
    for (const [id, serialized] of beforeMap) {
      if (afterMap.get(id) !== serialized) changedIds.add(id);
    }
    for (const id of afterMap.keys()) {
      if (!beforeMap.has(id)) changedIds.add(id);
    }
  }

  const isSubComp = (c: AppSpec['components'][number]) =>
    c.id === 'check-subscription' ||
    c.id === 'sub-trap' ||
    c.stateKey === 'subscription' ||
    c.stateKey === 'subscribe' ||
    /定期/.test(c.label);
  const isCouponComp = (c: AppSpec['components'][number]) =>
    c.id === 'popup-coupon' ||
    c.id === 'coupon-Box' ||
    c.stateKey === 'useCoupon' ||
    /クーポン/.test(c.label) ||
    /クーポン/.test(c.caption ?? '');

  const hasSubBefore = beforeSpec.components.some(isSubComp);
  const hasSubAfter = afterSpec.components.some(isSubComp);
  const hasCouponBefore = beforeSpec.components.some(isCouponComp);
  const hasCouponAfter = afterSpec.components.some(isCouponComp);

  const removedNeededFeature =
    (hasSubBefore && !hasSubAfter) || (hasCouponBefore && !hasCouponAfter);

  return {
    changedComponentIds: [...changedIds],
    removedNeededFeature,
  };
}

/** 振り返り文の中で、何番目の発言を引用するかの目印 */
function turnRef(turnIndex: number): string {
  return `{{turn:${turnIndex}}}`;
}

/**
 * 振り返り文の目印を、学習者のブラウザにある発言の本文に置き換える。
 * 本文が手元にないとき（画面を開き直したときなど）は、その指示、と書く
 */
export function fillTurnRefs(line: string, turnTexts: ReadonlyArray<string | undefined>): string {
  return line.replace(/\{\{turn:(\d+)\}\}/g, (_m, n: string) => {
    const text = turnTexts[Number(n)];
    return text && text.trim() ? cleanPromptForBadge(text) : 'その指示';
  });
}

/** 対象語は題材の語彙に限る。Natural Language API が取り出した語に人名などが混ざっても残さない */
export function limitEntitiesToVocabulary(entities: string[]): string[] {
  const kept: string[] = [];
  for (const entity of entities) {
    const term = UI_ENTITY_TERMS.find((t) => entity === t || entity.includes(t));
    if (term && !kept.includes(term)) kept.push(term);
  }
  return kept;
}

function cleanPromptForBadge(text: string): string {
  const cleaned = text.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 59)}…` : cleaned;
}

const GENERIC_MODIFIER_ENTITIES = new Set([
  'ボタン',
  'チェック',
  '文字',
  'サイズ',
  '大きさ',
  '色',
  '数字',
  '確認',
  '金額',
]);

function extractTargetTopics(event: PromptTelemetryEvent): Set<string> {
  const topics = new Set<string>();
  for (const id of event.changedComponentIds) {
    if (/sub/i.test(id)) topics.add('topic:subscription');
    if (/coupon|popup/i.test(id)) topics.add('topic:coupon');
    if (/countdown|timer/i.test(id)) topics.add('topic:countdown');
  }
  for (const ent of event.nlSignal.entities) {
    if (GENERIC_MODIFIER_ENTITIES.has(ent)) continue;
    if (ent === '定期便' || ent === 'おトク定期便' || ent === '解約条件' || ent === '注意書き') {
      topics.add('topic:subscription');
    } else if (
      ent === 'クーポン' ||
      ent === '割引' ||
      ent === '広告' ||
      ent === 'ポップアップ' ||
      ent === 'バナー' ||
      ent === '閉じるボタン'
    ) {
      topics.add('topic:coupon');
    } else if (ent === 'カウントダウン' || ent === '残り時間' || ent === 'タイマー') {
      topics.add('topic:countdown');
    } else {
      topics.add(`ent:${ent}`);
    }
  }
  return topics;
}

function sharesTurningPointTarget(
  prev: PromptTelemetryEvent,
  next: PromptTelemetryEvent,
): boolean {
  if (prev.embeddingSignal.closestArchetype === 'vague_delegate') {
    return true;
  }
  if (
    prev.changedComponentIds.length > 0 &&
    next.changedComponentIds.length > 0 &&
    prev.changedComponentIds.some((id) => next.changedComponentIds.includes(id))
  ) {
    return true;
  }
  const prevTopics = extractTargetTopics(prev);
  const nextTopics = extractTargetTopics(next);
  for (const t of prevTopics) {
    if (nextTopics.has(t)) return true;
  }
  return false;
}

/**
 * 記録されたテレメトリイベント列から、行動ベースの指標とシステムメッセージ行を生成する。
 * 括弧を使わず、固有名詞・数値・実プロンプト引用をすべてバッククォートで囲んで出力する。
 */
export function summarizePromptTelemetry(
  events: PromptTelemetryEvent[],
  cohortId?: TargetCohortId,
): PromptSessionSummary {
  const scoped = cohortId
    ? events.filter((e) => !e.cohortId || e.cohortId === cohortId)
    : events;
  const activeEvents = scoped.length > 0 ? scoped : events;

  const exploreEvents = activeEvents.filter((e) => e.sessionMode === 'explore');
  const executeEvents = activeEvents.filter((e) => e.sessionMode === 'execute');

  const exploreTurns = exploreEvents.length;
  const executeTurns = executeEvents.length;
  // 同じ部品を後からやり直した回数（isReworkOnSameComponent）を手戻り回数として数える。
  // やり直しが起きなかったが最後の状態で機能喪失（removedNeededFeature）のまま終わった指示があれば加算する。
  const reworkedComponentIds = new Set(
    executeEvents
      .filter((e) => e.isReworkOnSameComponent)
      .flatMap((e) => e.changedComponentIds),
  );
  const reworkTurns = executeEvents.filter(
    (e) =>
      e.isReworkOnSameComponent ||
      (e.removedNeededFeature &&
        !e.changedComponentIds.some((id) => reworkedComponentIds.has(id))),
  ).length;

  const goalDirectedTurns = executeEvents.filter(
    (e) => e.embeddingSignal.closestArchetype === 'goal_directed',
  ).length;

  const successfulExecutes = Math.max(0, executeTurns - reworkTurns);
  const firstShotSuccessRate =
    executeTurns > 0 ? Math.round((successfulExecutes / executeTurns) * 100) : 100;

  // 単純削除や手戻り指示のあとに、条件設計型・具体修正型で解決した転換点を探す
  let turningPoint: { beforeTurn: number; afterTurn: number } | undefined;
  let turningPointByGoal = false;
  for (let i = 0; i < executeEvents.length; i++) {
    const prev = executeEvents[i];
    const isInitialMistake =
      prev.removedNeededFeature ||
      prev.embeddingSignal.closestArchetype === 'simple_delete' ||
      prev.embeddingSignal.closestArchetype === 'vague_delegate';
    if (!isInitialMistake) continue;

    for (let j = i + 1; j < executeEvents.length; j++) {
      const next = executeEvents[j];
      if (
        !next.removedNeededFeature &&
        next.embeddingSignal.closestArchetype !== 'simple_delete' &&
        sharesTurningPointTarget(prev, next) &&
        (next.embeddingSignal.closestArchetype === 'condition_design' ||
          next.embeddingSignal.closestArchetype === 'goal_directed' ||
          next.nlSignal.hasConditionConstraint ||
          next.isReworkOnSameComponent)
      ) {
        turningPoint = { beforeTurn: prev.turnIndex, afterTurn: next.turnIndex };
        turningPointByGoal = next.embeddingSignal.closestArchetype === 'goal_directed';
      }
    }
  }

  // クリアに最も貢献した（条件指定または最後の成功した）実行プロンプト
  const bestExecute =
    [...executeEvents]
      .reverse()
      .find(
        (e) =>
          !e.removedNeededFeature &&
          (e.embeddingSignal.closestArchetype === 'goal_directed' ||
            e.embeddingSignal.closestArchetype === 'condition_design' ||
            e.nlSignal.hasConditionConstraint),
      ) ?? [...executeEvents].reverse().find((e) => !e.removedNeededFeature);

  const effectiveTurn = bestExecute?.turnIndex;
  const effectivePrompt = effectiveTurn !== undefined ? turnRef(effectiveTurn) : undefined;

  const systemLogLines: string[] = [];
  if (executeTurns > 0) {
    // 学び始めたばかりの人が読むので、専門用語を使わずに言う（質問＝探索型、直してと頼んだ＝実行型、
    // 同じ所を直し直した＝手戻り、1回で思いどおりに直った割合＝初回成功率）
    systemLogLines.push(
      `今回の記録 質問した \`${exploreTurns}回\` 直してと頼んだ \`${executeTurns}回\`${goalDirectedTurns > 0 ? ` うち目的を伝えた \`${goalDirectedTurns}回\`` : ''} 同じ所を直し直した \`${reworkTurns}回\` 1回で思いどおりに直った割合 \`${firstShotSuccessRate}%\``,
    );
    if (turningPoint) {
      systemLogLines.push(
        `指示の改善 \`${turnRef(turningPoint.beforeTurn)}\` から${turningPointByGoal ? '目的を伝えた' : '条件を具体化した'} \`${turnRef(turningPoint.afterTurn)}\` へ変えたことで客の満足と店長の納得が両立しました`,
      );
    } else if (effectivePrompt && bestExecute?.embeddingSignal.closestArchetype === 'goal_directed') {
      systemLogLines.push(
        `決め手になった指示 \`${effectivePrompt}\` は誰がどうできるようにしたいかを伝えていたため、直し方を任せても狙い通りに整いました`,
      );
    } else if (effectivePrompt) {
      const entityCount = bestExecute?.nlSignal.entities.length ?? 0;
      if (entityCount > 0 && bestExecute?.nlSignal.hasConditionConstraint) {
        systemLogLines.push(
          `決め手になった指示 \`${effectivePrompt}\` は対象の部品と変える条件が具体的だったため、直し直さずに反映されました`,
        );
      } else {
        systemLogLines.push(
          `決め手になった指示 \`${effectivePrompt}\` で狙い通りに画面が整いました`,
        );
      }
    }
  }

  return {
    cohortId,
    exploreTurns,
    executeTurns,
    reworkTurns,
    goalDirectedTurns,
    firstShotSuccessRate,
    turningPoint,
    effectiveTurn,
    systemLogLines,
  };
}

/**
 * クリア時にお助けAIが話す「概要・どこがよかったか・もっと何をしたら良くなるか」の事実リストと、
 * AIが使えないときの決定論的な3つの吹き出し文（fallbackLines）を組み立てる。
 * 事実判定はすべてコードで行い、括弧は使わない
 */
export function buildClearFeedbackFacts(input: ClearFeedbackInput): ClearFeedbackFacts {
  const { cohortLabel, summary, owner, otherCohorts, couponStatus = 'none' } = input;
  const subMetric = owner.metrics.find((m) => m.label.includes('定期')) ?? owner.metrics[0];

  // 1. 概要の事実とフォールバック文
  const overviewFacts: string[] = [
    `選んだ客層である \`${cohortLabel}\` の \`${owner.customers}人\` 全員が気持ちよく注文できた`,
    `店長やお客さんへの質問は \`${summary.exploreTurns}回\`、手直しの指示は \`${summary.executeTurns}回\` だった`,
  ];
  let subClause = '';
  if (subMetric) {
    if (subMetric.missing) {
      overviewFacts.push(`お店の${subMetric.label}の申し込み欄は画面から消えて0件になった`);
      subClause = `お店の${subMetric.label}は消えて0件になりましたが、`;
    } else if (subMetric.count > 0) {
      overviewFacts.push(`お店の${subMetric.label}も消さずに残し、${subMetric.count}件の申し込みが入った`);
      subClause = `お店の${subMetric.label}も \`${subMetric.count}件\` 入って、`;
    } else {
      overviewFacts.push(`お店の${subMetric.label}の欄は残したが、今回の客層での申し込みは0件だった`);
      subClause = `お店の${subMetric.label}の欄も残したまま、`;
    }
  }
  overviewFacts.push(
    `選ばなかったほかの客層では、\`${otherCohorts.total}人中${otherCohorts.achieved}人\` がこの画面で満足して買える状態になった`,
  );
  const fallbackOverview = `おつかれさまでした！\`${cohortLabel}\` の${owner.customers}人全員が気持ちよく買えましたね。質問 \`${summary.exploreTurns}回\` と手直し \`${summary.executeTurns}回\` でクリアし、${subClause}ほかの客層も \`${otherCohorts.total}人中${otherCohorts.achieved}人\` が満足できる画面に整っています`;

  // 2. どこがよかったかの事実とフォールバック文
  const goodPointFacts: string[] = [];
  const goodClauses: string[] = [];

  if (summary.turningPoint) {
    const beforeRef = `\`${turnRef(summary.turningPoint.beforeTurn)}\``;
    const afterRef = `\`${turnRef(summary.turningPoint.afterTurn)}\``;
    goodPointFacts.push(
      `最初は ${beforeRef} と指示したあと、お店の事情やお客さんの反応を見て ${afterRef} へ切り替えられたこと`,
    );
    goodClauses.push(
      `最初は ${beforeRef} としたあと、反応を見て ${afterRef} へ切り替えられたところ`,
    );
  } else if (summary.effectiveTurn !== undefined) {
    const effRef = `\`${turnRef(summary.effectiveTurn)}\``;
    if (summary.goalDirectedTurns > 0) {
      goodPointFacts.push(
        `決め手になった ${effRef} で、誰がどうできるようにしたいかという目的を言葉にして伝えられたこと`,
      );
      goodClauses.push(
        `決め手になった ${effRef} のように、誰のためにどうしたいかという目的を伝えてくれたところ`,
      );
    } else {
      goodPointFacts.push(
        `決め手になった ${effRef} で、直したい部品と条件をはっきり伝えられたこと`,
      );
      goodClauses.push(
        `決め手になった ${effRef} のように、直したい部品と条件をはっきり伝えてくれたところ`,
      );
    }
  }

  if (subMetric && !subMetric.missing && subMetric.count > 0) {
    goodPointFacts.push(
      `${subMetric.label}をただ消すのではなく、望む人が安心して選べる形で残して店長の売上とお客さんの満足を両立できたこと`,
    );
    goodClauses.push(
      `${subMetric.label}を消さずに正直な形で残してお客さんの安心と店長の売上を両立できた点`,
    );
  }
  if (couponStatus === 'usable_discount') {
    goodPointFacts.push(
      'クーポン広告をただ消すのではなく、画面内でその場で割引が効く使いやすい形に整えて残せたこと',
    );
    goodClauses.push('クーポンもその場で割引が使える形に整えて残せた点');
  }
  if (summary.exploreTurns > 0) {
    goodPointFacts.push(
      `手直しする前にお客さんや店長へ \`${summary.exploreTurns}回\` 質問して、困りごとや事情を確かめてから判断できたこと`,
    );
    goodClauses.push('事前に質問して事情を確かめてから手直しできた点');
  }
  if (summary.reworkTurns === 0 && summary.executeTurns > 0) {
    goodPointFacts.push('同じ部品の直し直しが0回で、1回で狙いどおりに画面を整えられたこと');
    goodClauses.push('同じ箇所を直し直すことなく1回で狙いどおりに進められた点');
  }
  if (otherCohorts.achieved === otherCohorts.total && otherCohorts.total > 0) {
    goodPointFacts.push(
      `選んだ3人だけでなく、選ばなかった客層の${otherCohorts.total}人全員も同時に満足できる画面に仕上げられたこと`,
    );
  }
  if (goodPointFacts.length === 0) {
    goodPointFacts.push(`選んだ \`${cohortLabel}\` の3人が迷わず買える画面までしっかり手直しできたこと`);
    goodClauses.push(`選んだ \`${cohortLabel}\` の3人が迷わず買える画面までしっかり手直しできたところ`);
  }

  const primaryGood = goodClauses[0];
  const secondaryGood = goodClauses[1];
  const fallbackGoodPoints = secondaryGood
    ? `よかったのは、${primaryGood}です。さらに${secondaryGood}も素敵でした`
    : `よかったのは、${primaryGood}です`;

  // 3. もっと何をしたら良くなるかの事実とフォールバック文
  const improvementFacts: string[] = [];
  const improvementClauses: string[] = [];

  if (subMetric?.missing) {
    improvementFacts.push(
      `今回は${subMetric.label}の欄を消してクリアしたため、毎月届けてほしいお客さんや店長が残念がっている。次は消さずに最初のチェックを外し、条件が分かる形で残すと両方満足できること`,
    );
    improvementClauses.push(
      `今回は${subMetric.label}を消してクリアしましたが、毎月届けてほしいお客さんや店長は残念がっているので、次は消さずに最初のチェックを外して条件が分かる形で残すと両立できます`,
    );
  }

  const hasCouponMissing =
    couponStatus === 'removed' ||
    otherCohorts.unhappy.some((u) => u.reason.includes('クーポンがなくなって'));
  const hasCouponNoDiscount =
    couponStatus === 'kept_no_discount' ||
    otherCohorts.unhappy.some(
      (u) => u.reason.includes('クーポンがあったのに') || u.reason.includes('クーポンを使っても'),
    );

  if (hasCouponMissing) {
    improvementFacts.push(
      'クーポンを消したため、少しでも安く買いたいお客さんが残念がっている。次は画面内で押すとその場で割引になるクーポンとして残すとさらに良くなること',
    );
    improvementClauses.push(
      'クーポンを消したことで損をしたくないお客さんが残念がっているので、次は画面内でその場で割引が効く形にして残すとさらに良くなります',
    );
  } else if (hasCouponNoDiscount) {
    improvementFacts.push(
      'クーポンの表示はあるが合計金額が下がらない状態のため、押すとその場で割引が効くように整えると損をしたくないお客さんも満足できること',
    );
    improvementClauses.push(
      'クーポンを押したときに合計金額が下がるように整えると、損をしたくないお客さんも満足できます',
    );
  }

  const needsConfirm = otherCohorts.unhappy.some((u) =>
    u.reason.includes('確かめる画面がなかった'),
  );
  const tooManySteps = otherCohorts.unhappy.some(
    (u) => u.reason.includes('手順が多すぎる') || u.reason.includes('時間がかかりすぎる'),
  );

  if (needsConfirm) {
    improvementFacts.push(
      '選ばなかった確実に買いたい人の客層では、注文を確定する前に内容を確かめる画面がないため離脱する人がいる。次は確認画面を足すか、さっと買いたい人とも両立できるよう前回設定のショートカットと組み合わせるとさらに良くなること',
    );
    improvementClauses.push(
      '選ばなかった客層では注文前に内容を確かめる画面がないため離脱する人がいるので、次は確認画面を足すか、前回設定で一括入力できるボタンと組み合わせるとさらに多くの人が買えるようになります',
    );
  } else if (tooManySteps) {
    improvementFacts.push(
      '選ばなかったさっと買いたい人の客層では、手数や時間がかかりすぎて離脱する人がいる。前回と同じ設定で一括入力できるボタンを足すと、確認の安心と手数の少なさを両立できること',
    );
    improvementClauses.push(
      '選ばなかったさっと買いたい人の客層では手数が増えて離脱する人がいるので、前回と同じ設定でまとめて入力できるボタンを足すと両立できます',
    );
  } else if (otherCohorts.unhappy.length > 0 && improvementClauses.length === 0) {
    const firstUnhappy = otherCohorts.unhappy[0];
    improvementFacts.push(
      `選ばなかった客層では、\`${firstUnhappy.name}\` が \`${firstUnhappy.reason}\` ため満足できていない。ここも整えるとさらに多くの人が気持ちよく買えること`,
    );
    improvementClauses.push(
      `選ばなかった客層では \`${firstUnhappy.name}\` が \`${firstUnhappy.reason}\` 状態で困っているので、次はそこも整えるとさらに良くなります`,
    );
  }

  if (summary.exploreTurns === 0) {
    improvementFacts.push(
      '今回は店長やお客さんへの質問が0回だったため、次は手直しの前に誰が何に困っているかを質問してから直すと、より少ない手数で両立しやすくなること',
    );
    improvementClauses.push(
      '次は手直しの前に店長やお客さんへ質問して事情を確かめてから直すと、もっと少ない手数で狙いどおりに直せますよ',
    );
  } else if (summary.goalDirectedTurns === 0) {
    improvementFacts.push(
      '次は部品の具体的な直し方だけでなく、誰がどうできるようにしたいかという目的を伝えてみると、お助けAIが細かい直し方をまとめて担えること',
    );
    improvementClauses.push(
      '次は部品の細かい直し方だけでなく、誰がどうできるようにしたいかという目的で伝えてみると、お助けAIがまとめて形にできますよ',
    );
  } else if (summary.reworkTurns > 0) {
    improvementFacts.push(
      `同じ箇所を \`${summary.reworkTurns}回\` 直し直したため、消す前に店長やお客さんの希望を確かめて条件を伝えると1回で決まりやすくなること`,
    );
    improvementClauses.push(
      '消す前に店長やお客さんの希望を確かめてから条件を伝えると、直し直しを減らして1回で決めやすくなりますよ',
    );
  }

  if (improvementFacts.length === 0) {
    improvementFacts.push(
      '9人全員の満足と店長の売上がすでに両立できており、指示の出し方も理想的だった。次は別の客層から始めてさらに少ない手数でのクリアを目指すと良い練習になること',
    );
    improvementClauses.push(
      'すでに9人全員の満足と店長の売上が両立できているので、次は別の客層から始めてさらに少ない手数で同じ着地点を目指してみてくださいね',
    );
  }

  const primaryImp = improvementClauses[0];
  const secondaryImp = improvementClauses.length > 1 ? improvementClauses[improvementClauses.length - 1] : undefined;
  const fallbackImprovements =
    secondaryImp && secondaryImp !== primaryImp
      ? `もっと良くするなら、${primaryImp}。あわせて、${secondaryImp}`
      : `もっと良くするなら、${primaryImp}`;

  return {
    overviewFacts,
    goodPointFacts,
    improvementFacts,
    fallbackLines: [fallbackOverview, fallbackGoodPoints, fallbackImprovements],
  };
}

/** 個人の挑戦が推測されないよう、公開の集計で数値を出すために必要な最小の挑戦数 */
export const MIN_PUBLIC_RUN_COUNT = 3;

export const ARCHETYPE_PUBLIC_LABELS: ReadonlyArray<{
  archetype: PromptArchetype;
  label: string;
}> = [
  { archetype: 'goal_directed', label: '目的を伝えた指示' },
  { archetype: 'condition_design', label: '条件を具体化した指示' },
  { archetype: 'direct_fix', label: '具体的に直した指示' },
  { archetype: 'inquiry', label: '店長やお客さんへの質問' },
  { archetype: 'simple_delete', label: '単純に消す指示' },
  { archetype: 'vague_delegate', label: '丸投げした指示' },
];

export interface PublicAggregateCohortStat {
  cohortId: TargetCohortId;
  label: string;
  /** この客層の挑戦が minRunsForDisplay 未満なら true（内訳の数字は伏せる） */
  suppressed: boolean;
  runCount?: number;
  clearedCount?: number;
  clearRatePercent?: number;
  avgExecuteTurnsOnClear?: number | null;
}

export interface PublicAggregateStats {
  /** BigQuery との連携が有効で取得できたか */
  available: boolean;
  /** 集計した時刻（ISO 8601） */
  generatedAt: string;
  /** 個人が特定されないために必要な最小の挑戦数（既定は3件） */
  minRunsForDisplay: number;
  /** 全体の挑戦が minRunsForDisplay 未満なら true（全体の内訳も伏せる） */
  suppressed: boolean;
  totalRuns?: number;
  clearedRuns?: number;
  resetRuns?: number;
  abandonedRuns?: number;
  clearRatePercent?: number;
  avgExecuteTurnsOnClear?: number | null;
  totalPrompts?: number;
  reworkRatePercent?: number;
  removedNeededFeatureRatePercent?: number;
  archetypeBreakdown?: Array<{
    archetype: PromptArchetype;
    label: string;
    count: number;
    percent: number;
  }>;
  topEntities?: Array<{ term: string; count: number }>;
  cohorts: PublicAggregateCohortStat[];
}

export interface RawBigQueryAggregatePayload {
  runTotals?: {
    total_runs?: number | string | null;
    cleared_runs?: number | string | null;
    reset_runs?: number | string | null;
    abandoned_runs?: number | string | null;
    avg_execute_turns_on_clear?: number | string | null;
  } | null;
  cohortStats?: Array<{
    cohort_id?: string | null;
    run_count?: number | string | null;
    cleared_count?: number | string | null;
    avg_execute_turns_on_clear?: number | string | null;
  }> | null;
  promptTotals?: {
    total_prompts?: number | string | null;
    execute_prompts?: number | string | null;
    rework_prompts?: number | string | null;
    removed_needed_prompts?: number | string | null;
  } | null;
  archetypeStats?: Array<{
    archetype?: string | null;
    cnt?: number | string | null;
  }> | null;
  entityStats?: Array<{
    term?: string | null;
    cnt?: number | string | null;
  }> | null;
}

function toSafeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toSafeAvg(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(1)) : null;
}

/**
 * BigQuery の集計結果から、公開用の集計データを組み立てる。
 * 挑戦数が minRunsForDisplay（既定3件）に満たない全体または客層区分は suppressed: true にし、数値を出さない
 */
export function formatPublicAggregateStats(
  raw: RawBigQueryAggregatePayload | null | undefined,
  cohorts: ReadonlyArray<{ id: TargetCohortId; label: string }>,
  options: {
    available?: boolean;
    minRunsForDisplay?: number;
    generatedAt?: string;
  } = {},
): PublicAggregateStats {
  const available = options.available ?? Boolean(raw);
  const minRunsForDisplay = options.minRunsForDisplay ?? MIN_PUBLIC_RUN_COUNT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  if (!available || !raw) {
    return {
      available: false,
      generatedAt,
      minRunsForDisplay,
      suppressed: true,
      cohorts: cohorts.map((c) => ({
        cohortId: c.id,
        label: c.label,
        suppressed: true,
      })),
    };
  }

  const totalRuns = toSafeInt(raw.runTotals?.total_runs);
  if (totalRuns < minRunsForDisplay) {
    return {
      available: true,
      generatedAt,
      minRunsForDisplay,
      suppressed: true,
      cohorts: cohorts.map((c) => ({
        cohortId: c.id,
        label: c.label,
        suppressed: true,
      })),
    };
  }

  const clearedRuns = toSafeInt(raw.runTotals?.cleared_runs);
  const resetRuns = toSafeInt(raw.runTotals?.reset_runs);
  const abandonedRuns = toSafeInt(raw.runTotals?.abandoned_runs);
  const clearRatePercent = Math.round((clearedRuns / totalRuns) * 100);
  const avgExecuteTurnsOnClear =
    clearedRuns >= minRunsForDisplay
      ? toSafeAvg(raw.runTotals?.avg_execute_turns_on_clear)
      : null;

  const totalPrompts = toSafeInt(raw.promptTotals?.total_prompts);
  const executePrompts = toSafeInt(raw.promptTotals?.execute_prompts);
  const reworkPrompts = toSafeInt(raw.promptTotals?.rework_prompts);
  const removedNeededPrompts = toSafeInt(raw.promptTotals?.removed_needed_prompts);

  const reworkRatePercent =
    executePrompts >= minRunsForDisplay
      ? Math.round((reworkPrompts / executePrompts) * 100)
      : undefined;
  const removedNeededFeatureRatePercent =
    executePrompts >= minRunsForDisplay
      ? Math.round((removedNeededPrompts / executePrompts) * 100)
      : undefined;

  const archetypeCountMap = new Map<PromptArchetype, number>();
  for (const row of raw.archetypeStats ?? []) {
    const key = row?.archetype as PromptArchetype | undefined;
    if (key && ARCHETYPE_PUBLIC_LABELS.some((item) => item.archetype === key)) {
      archetypeCountMap.set(key, toSafeInt(row?.cnt));
    }
  }
  const archetypeBreakdown =
    totalPrompts >= minRunsForDisplay
      ? ARCHETYPE_PUBLIC_LABELS.map(({ archetype, label }) => {
          const count = archetypeCountMap.get(archetype) ?? 0;
          return {
            archetype,
            label,
            count,
            percent: Math.round((count / totalPrompts) * 100),
          };
        })
      : undefined;

  const topEntities: Array<{ term: string; count: number }> = [];
  for (const row of raw.entityStats ?? []) {
    const allowed = limitEntitiesToVocabulary([row?.term ?? '']);
    const count = toSafeInt(row?.cnt);
    if (allowed.length === 1 && count >= minRunsForDisplay) {
      const term = allowed[0];
      if (!topEntities.some((e) => e.term === term)) {
        topEntities.push({ term, count });
      }
    }
  }

  const cohortMap = new Map<string, NonNullable<RawBigQueryAggregatePayload['cohortStats']>[number]>();
  for (const row of raw.cohortStats ?? []) {
    if (row?.cohort_id) {
      cohortMap.set(row.cohort_id, row);
    }
  }

  const cohortResults: PublicAggregateCohortStat[] = cohorts.map((c) => {
    const row = cohortMap.get(c.id);
    const runCount = toSafeInt(row?.run_count);
    if (runCount < minRunsForDisplay) {
      return {
        cohortId: c.id,
        label: c.label,
        suppressed: true,
      };
    }
    const clearedCount = toSafeInt(row?.cleared_count);
    return {
      cohortId: c.id,
      label: c.label,
      suppressed: false,
      runCount,
      clearedCount,
      clearRatePercent: Math.round((clearedCount / runCount) * 100),
      avgExecuteTurnsOnClear:
        clearedCount >= minRunsForDisplay ? toSafeAvg(row?.avg_execute_turns_on_clear) : null,
    };
  });

  return {
    available: true,
    generatedAt,
    minRunsForDisplay,
    suppressed: false,
    totalRuns,
    clearedRuns,
    resetRuns,
    abandonedRuns,
    clearRatePercent,
    avgExecuteTurnsOnClear,
    totalPrompts: totalPrompts >= minRunsForDisplay ? totalPrompts : undefined,
    reworkRatePercent,
    removedNeededFeatureRatePercent,
    archetypeBreakdown,
    topEntities,
    cohorts: cohortResults,
  };
}
