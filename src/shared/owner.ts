// 店長（依頼主）の反応。お客さんの結果から、お店の側の数字を数えて一言にする。
// 数字はコードで数え、AIには任せない（お店の側の結果もお客さんの達成・離脱と同じく客観的にする）。

import {
  createInitialState,
  hasCompletionAction,
  isHonestOptInComponent,
  renderLabel,
  type AppState,
} from './appRuntime.ts';
import type { OwnerDefinition } from './theme.ts';
import type { AppSpec, OwnerReport, ReviewOutcome } from './types.ts';

export interface OwnerInput {
  outcome: ReviewOutcome;
  finalState?: AppState;
}

/** せりふの {名前} を値に置き換える */
function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

function matchesMetric(value: unknown, countWhen: true | 'filled'): boolean {
  if (countWhen === 'filled') return value !== undefined && value !== '' && value !== false;
  return value === true || value === 'true';
}

export function buildOwnerReport(
  owner: OwnerDefinition,
  spec: AppSpec,
  results: OwnerInput[],
): OwnerReport {
  // 不満があっても後悔していても、買ってくれたことに変わりはない
  const ordered = results.filter((r) => r.outcome !== 'abandoned');
  // 店にあったか（状態の変数があるか）と、今も画面で選べるか（その状態を使う部品があるか）を分けて見る。
  // 部品を消しても変数は残るため、変数だけで判断すると、消した欄の申し込みを数えてしまう
  const stateKeys = new Set(spec.state.map((s) => s.key));
  const boundKeys = new Set(spec.components.map((c) => c.stateKey).filter(Boolean));

  const metrics = owner.metrics
    .filter((m) => stateKeys.has(m.stateKey))
    .map((m) => ({
      label: m.label,
      missing: !boundKeys.has(m.stateKey),
      reportWhenMissing: m.reportWhenMissing ?? false,
      count: ordered.filter((r) => matchesMetric(r.finalState?.[m.stateKey], m.countWhen)).length,
    }))
    // 画面からなくなった項目は、なくなったことに触れる指定があるものだけ残す
    .filter((m) => !m.missing || m.reportWhenMissing);

  const lines = owner.lines;
  const counts = { customers: results.length, orders: ordered.length };
  const parts: string[] = [];
  if (ordered.length === 0) {
    parts.push(fill(lines.noOrders, counts));
  } else if (ordered.length === results.length) {
    parts.push(fill(lines.allOrdered, counts));
  } else {
    parts.push(fill(lines.someOrdered, counts));
  }
  if (ordered.length > 0) {
    for (const m of metrics) {
      const vars = { ...counts, label: m.label, count: m.count };
      if (m.missing) parts.push(fill(lines.metricMissing, vars));
      else if (m.count > 0) parts.push(fill(lines.metricTaken, vars));
      else parts.push(fill(lines.metricZero, vars));
    }
  }

  return {
    orders: ordered.length,
    customers: results.length,
    metrics: metrics.map(({ label, count, missing }) => ({ label, count, missing })),
    comment: parts.join(' '),
  };
}

/** 改造で変わったことのうち店長が気にするもの。fact はAIに渡す事実、line はAIを使えないときの決まったせりふ */
export interface OwnerChangeFact {
  fact: string;
  line: string;
  componentId?: string;
}

function labelsOf(spec: AppSpec, ids: string[]): string {
  const state = createInitialState(spec);
  return ids
    .map((id) => {
      const comp = spec.components.find((c) => c.id === id);
      return comp ? renderLabel(comp, state) : '';
    })
    .filter(Boolean)
    .map((l) => `「${l}」`)
    .join('と');
}

/**
 * 画面が改造された直後に、店長が気にする変化を変更前後の仕様から調べる。
 * 何が変わったかはコードで決め、言い方だけをAIに任せる（数字や事実がぶれないようにする）
 */
export function describeOwnerChange(
  owner: OwnerDefinition,
  prevSpec: AppSpec,
  nextSpec: AppSpec,
): OwnerChangeFact[] {
  const lines = owner.lines;
  const facts: OwnerChangeFact[] = [];
  const removedIds = (pred: (c: AppSpec['components'][number]) => boolean) =>
    prevSpec.components
      .filter((c) => pred(c) && !nextSpec.components.some((n) => n.id === c.id))
      .map((c) => c.id);

  const prevHadCompletion = prevSpec.components.some(
    (c) => c.type === 'button' && hasCompletionAction(c),
  );
  const nextCompletionBtn = nextSpec.components.find(
    (c) => c.type === 'button' && hasCompletionAction(c),
  );
  if (!prevHadCompletion && nextCompletionBtn) {
    facts.push({
      fact: '押しても反応しなかった購入のボタンが、押せば買えるようになった',
      line: lines.completionFixed,
      componentId: nextCompletionBtn.id,
    });
  }

  // 店長が重視している数字（題材で決めたもの）の変化を調べる
  for (const m of owner.metrics) {
    const prevComp = prevSpec.components.find((c) => c.stateKey === m.stateKey);
    const nextComp = nextSpec.components.find((c) => c.stateKey === m.stateKey);
    const prevState = prevSpec.state.find((s) => s.key === m.stateKey);
    const nextState = nextSpec.state.find((s) => s.key === m.stateKey);

    if (prevComp && !nextComp) {
      facts.push({
        fact: `お店の売上につながる${m.label}の申し込み欄を、画面から消した`,
        line: fill(lines.metricRemoved, { label: m.label }),
      });
    } else if (
      m.countWhen === true &&
      isHonestOptInComponent(nextComp, nextState?.initialValue) &&
      !isHonestOptInComponent(prevComp, prevState?.initialValue)
    ) {
      facts.push({
        fact: `${m.label}を消さずに残したうえで、最初のチェックを外して文字や条件を正直で分かりやすい形に整えた`,
        line: `おっ、${m.label}を消さずに分かりやすく残してくれたんだな！それでお客さんが選んでくれるなら嬉しいよ`,
        componentId: nextComp?.id,
      });
    } else if (
      m.countWhen === true &&
      prevState?.initialValue === true &&
      nextState?.initialValue === false
    ) {
      facts.push({
        fact: `${m.label}に最初から入っていたチェックを外し、申し込みたい人だけが自分で選ぶようにした`,
        line: fill(lines.metricUnchecked, { label: m.label }),
        componentId: nextComp?.id,
      });
    } else if (prevComp && nextComp && prevComp.style.size === 'xs' && nextComp.style.size !== 'xs') {
      facts.push({
        fact: `小さくて目立たなかった${m.label}の説明を、読める大きさにした`,
        line: fill(lines.metricEnlarged, { label: m.label }),
        componentId: nextComp.id,
      });
    }
  }

  const popups = removedIds((c) => c.role === 'popup');
  if (popups.length > 0) {
    facts.push({
      fact: `店長が付けた広告${labelsOf(prevSpec, popups)}を消した`,
      line: lines.popupRemoved,
    });
  } else {
    // 広告を消さずに、閉じるボタンの位置・大きさや表示形式（バナー化・特典化）を工夫した場合
    for (const prevPopup of prevSpec.components.filter((c) => c.role === 'popup' || c.type === 'popup')) {
      const nextPopup = nextSpec.components.find((n) => n.id === prevPopup.id);
      if (!nextPopup) continue;
      const closeImproved =
        (prevPopup.closePosition ?? 'top-right') !== (nextPopup.closePosition ?? 'top-right') ||
        (prevPopup.closeSize ?? prevPopup.style.size) !== (nextPopup.closeSize ?? nextPopup.style.size) ||
        (prevPopup.closeLabel ?? '') !== (nextPopup.closeLabel ?? '');
      const convertedToInline = prevPopup.type === 'popup' && nextPopup.type !== 'popup';
      const removedPageHijack =
        prevPopup.actions.some((a) => a.type === 'open_page') &&
        !nextPopup.actions.some((a) => a.type === 'open_page');
      if (closeImproved || convertedToInline || removedPageHijack || Boolean(nextPopup.customHtml)) {
        facts.push({
          fact: `店長が付けた広告「${renderLabel(prevPopup, createInitialState(prevSpec))}」を消さずに、お客さんが邪魔にならず見やすい形に工夫して残した`,
          line: 'おっ、広告を消さずに押しやすく工夫して残してくれたんだな！それならお店の宣伝もできて助かるよ',
          componentId: nextPopup.id,
        });
      }
    }
  }
  const decoys = removedIds((c) => c.role === 'decoy');
  if (decoys.length > 0) {
    facts.push({
      fact: `店長が目立たせていたボタン${labelsOf(prevSpec, decoys)}を消した`,
      line: lines.distractionRemoved,
    });
  }
  const distractions = removedIds((c) => c.role === 'distraction');
  if (distractions.length > 0) {
    facts.push({
      fact: `店長が付けた煽りの表示${labelsOf(prevSpec, distractions)}を消した`,
      line: lines.distractionRemoved,
    });
  } else {
    for (const prevDist of prevSpec.components.filter((c) => c.role === 'distraction')) {
      const nextDist = nextSpec.components.find((n) => n.id === prevDist.id);
      if (
        nextDist &&
        (prevDist.darkPattern === 'false_urgency' || prevDist.label.includes('{countdown}')) &&
        nextDist.darkPattern !== 'false_urgency' &&
        !nextDist.label.includes('{countdown}')
      ) {
        facts.push({
          fact: `急かすカウントダウン表示を、正直で安心できる案内「${renderLabel(nextDist, createInitialState(nextSpec))}」に書き換えた`,
          line: 'なるほど、急かすんじゃなくて気持ちよく買ってもらえる案内に変えたんだな！',
          componentId: nextDist.id,
        });
      }
    }
  }

  // 確認ダイアログまたは確認ステップの追加
  const hasConfirm = (spec: AppSpec) =>
    spec.components.some((c) => c.behavior?.effect === 'confirm_dialog') ||
    spec.state.some((s) => s.key === 'step');
  if (!hasConfirm(prevSpec) && hasConfirm(nextSpec)) {
    const confirmComp =
      nextSpec.components.find((c) => c.behavior?.effect === 'confirm_dialog') ??
      nextSpec.components.find((c) => c.visibleWhen?.stateKey === 'step' && c.role === 'primary_action');
    facts.push({
      fact: '注文を確定する前に、内容を確かめる確認を足した',
      line: lines.confirmAdded,
      componentId: confirmComp?.id,
    });
  }

  return facts;
}

/** 改造の直後の店長の反応を、決まったせりふでつなげる（AIを使えないとき・テスト用） */
export function buildOwnerChangeReaction(
  owner: OwnerDefinition,
  prevSpec: AppSpec,
  nextSpec: AppSpec,
): string {
  return [...new Set(describeOwnerChange(owner, prevSpec, nextSpec).map((f) => f.line))].join('\n');
}

/**
 * 選んだお客さん全員が満足して買えた（クリア）時の、店長の締めのセリフを作る。
 */
export function buildOwnerClosingLines(
  owner: OwnerDefinition,
  report: OwnerReport | undefined,
  fallbackCustomers = 3,
): string[] {
  const customers = report?.customers ?? fallbackCustomers;
  const taken = (report?.metrics ?? []).filter((m) => m.count > 0);
  if (taken.length > 0) {
    const metrics = taken.map((m) => `${m.label}も${m.count}件`).join('、');
    return owner.lines.closingWithMetrics.map((line) => fill(line, { customers, metrics }));
  }
  return owner.lines.closingWithoutMetrics.map((line) => fill(line, { customers }));
}
