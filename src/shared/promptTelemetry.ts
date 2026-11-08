// プロンプト・テレメトリ分析と行動ベースの到達効率集計
// 主指標はLLMの主観採点ではなく、探索と実行を分離した行動データ（初回到達率・往復数・手戻り有無）に置く。

import type { AppSpec, SpecPatch, TargetCohortId } from './types.ts';

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
