// 店長（依頼主）の反応。お客さんの結果から、お店の側の数字を数えて一言にする。
// 数字はコードで数え、AIには任せない（お店の側の結果もお客さんの達成・離脱と同じく客観的にする）。

import { hasCompletionAction, type AppState } from './appRuntime.ts';
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
  const ordered = results.filter((r) => r.outcome === 'achieved' || r.outcome === 'regretted');
  const stateKeys = new Set(spec.state.map((s) => s.key));

  const metrics = owner.metrics
    .map((m) => ({
      label: m.label,
      missing: !stateKeys.has(m.stateKey),
      reportWhenMissing: m.reportWhenMissing ?? false,
      count: ordered.filter((r) => matchesMetric(r.finalState?.[m.stateKey], m.countWhen)).length,
    }))
    // 画面にない項目は、なくなったことに触れる指定があるものだけ残す
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

/**
 * 画面が改造された直後に、店長が変更前後の仕様差分からお店・売上の立場でリアクションする。
 */
export function buildOwnerChangeReaction(
  owner: OwnerDefinition,
  prevSpec: AppSpec,
  nextSpec: AppSpec,
): string {
  const lines = owner.lines;
  const reactions: string[] = [];

  const prevHadCompletion = prevSpec.components.some(
    (c) => c.type === 'button' && hasCompletionAction(c),
  );
  const nextHasCompletion = nextSpec.components.some(
    (c) => c.type === 'button' && hasCompletionAction(c),
  );
  if (!prevHadCompletion && nextHasCompletion) {
    reactions.push(lines.completionFixed);
  }

  // 店長が重視している数字（題材で決めたもの）の変化を調べる
  for (const m of owner.metrics) {
    const prevComp = prevSpec.components.find((c) => c.stateKey === m.stateKey);
    const nextComp = nextSpec.components.find((c) => c.stateKey === m.stateKey);
    const prevState = prevSpec.state.find((s) => s.key === m.stateKey);
    const nextState = nextSpec.state.find((s) => s.key === m.stateKey);

    if (prevComp && !nextComp) {
      reactions.push(fill(lines.metricRemoved, { label: m.label }));
    } else if (
      m.countWhen === true &&
      prevState?.initialValue === true &&
      nextState?.initialValue === false
    ) {
      reactions.push(fill(lines.metricUnchecked, { label: m.label }));
    } else if (
      prevComp &&
      nextComp &&
      prevComp.style.size === 'xs' &&
      nextComp.style.size !== 'xs'
    ) {
      reactions.push(fill(lines.metricEnlarged, { label: m.label }));
    }
  }

  // 時間差で出る広告の削除
  const prevPopups = prevSpec.components.filter((c) => c.role === 'popup').length;
  const nextPopups = nextSpec.components.filter((c) => c.role === 'popup').length;
  if (prevPopups > nextPopups) {
    reactions.push(lines.popupRemoved);
  }

  // おとりボタン・煽りバナーの削除
  const prevDecoysOrDistractions = prevSpec.components.filter(
    (c) => c.role === 'decoy' || c.role === 'distraction',
  ).length;
  const nextDecoysOrDistractions = nextSpec.components.filter(
    (c) => c.role === 'decoy' || c.role === 'distraction',
  ).length;
  if (prevDecoysOrDistractions > nextDecoysOrDistractions) {
    reactions.push(lines.distractionRemoved);
  }

  // 確認ダイアログまたは確認ステップの追加
  const prevConfirms =
    prevSpec.components.some((c) => c.behavior?.effect === 'confirm_dialog') ||
    prevSpec.state.some((s) => s.key === 'step');
  const nextConfirms =
    nextSpec.components.some((c) => c.behavior?.effect === 'confirm_dialog') ||
    nextSpec.state.some((s) => s.key === 'step');
  if (!prevConfirms && nextConfirms) {
    reactions.push(lines.confirmAdded);
  }

  if (reactions.length === 0) {
    return '';
  }

  return reactions.join('\n');
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
