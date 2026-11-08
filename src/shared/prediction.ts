// お客さんの反応を見る前の「結果予想（仮説検証）」の記録と判定。
// 手直しのあとに受動的に結果を見るだけでなく、今の画面で3人がそれぞれどうなるかを予想してから確かめることで、
// 自分の想定とお客さんの実際の行動のギャップに気づけるようにする。

import type { ReviewOutcome } from './types.ts';

export interface PredictionOption {
  outcome: ReviewOutcome;
  label: string;
}

export const PREDICTION_OPTIONS: readonly PredictionOption[] = [
  { outcome: 'achieved', label: '満足して買える' },
  { outcome: 'bothered', label: '買えたけど不満' },
  { outcome: 'abandoned', label: '途中でやめる' },
  { outcome: 'regretted', label: '後悔する' },
];

const OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  achieved: '満足して買える',
  bothered: '買えたけど不満',
  abandoned: '途中でやめる',
  regretted: '後悔する',
};

export function outcomePredictionLabel(outcome: ReviewOutcome): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

/** 反応確認1回分の予想の記録 */
export interface PredictionRound {
  /** 予想してから反応を見たか（「予想せずすぐ見る」なら false） */
  predicted: boolean;
  /** 予想した人数 */
  total: number;
  /** 予想が当たった人数 */
  hits: number;
  /** 不満・離脱・後悔（achieved 以外）を予想して当てた人数 */
  caughtIssueCount: number;
}

export interface PredictionSummary {
  /** 反応を見た回数 */
  totalRounds: number;
  /** 予想してから反応を見た回数 */
  predictedRounds: number;
  /** 予想した延べ人数 */
  total: number;
  /** 予想が当たった延べ人数 */
  hits: number;
  /** 不満・離脱・後悔を予想して当てた延べ人数 */
  caughtIssueCount: number;
  /** 困りごと（achieved 以外）を1回以上見抜けたか */
  caughtIssue: boolean;
}

/** 1回の反応確認の予想を、実際の結果と突き合わせる */
export function scorePredictionRound(
  results: ReadonlyArray<{ reviewerId: string; outcome: ReviewOutcome }>,
  predictions?: Readonly<Record<string, ReviewOutcome>>,
): PredictionRound {
  if (!predictions || Object.keys(predictions).length === 0) {
    return { predicted: false, total: 0, hits: 0, caughtIssueCount: 0 };
  }
  let total = 0;
  let hits = 0;
  let caughtIssueCount = 0;
  for (const r of results) {
    const predictedOutcome = predictions[r.reviewerId];
    if (!predictedOutcome) continue;
    total++;
    if (predictedOutcome === r.outcome) {
      hits++;
      if (r.outcome !== 'achieved') {
        caughtIssueCount++;
      }
    }
  }
  if (total === 0) {
    return { predicted: false, total: 0, hits: 0, caughtIssueCount: 0 };
  }
  return { predicted: true, total, hits, caughtIssueCount };
}

/** 1回の挑戦を通した予想の記録をまとめる */
export function summarizePredictions(rounds: readonly PredictionRound[]): PredictionSummary {
  const totalRounds = rounds.length;
  const predictedRounds = rounds.filter((r) => r.predicted).length;
  const total = rounds.reduce((acc, r) => acc + r.total, 0);
  const hits = rounds.reduce((acc, r) => acc + r.hits, 0);
  const caughtIssueCount = rounds.reduce((acc, r) => acc + r.caughtIssueCount, 0);
  return {
    totalRounds,
    predictedRounds,
    total,
    hits,
    caughtIssueCount,
    caughtIssue: caughtIssueCount > 0,
  };
}

/** お客さんの吹き出しに添える答え合わせの表示文を作る */
export function formatPredictionBadgeText(
  predicted: ReviewOutcome,
  actual: ReviewOutcome,
): { matched: boolean; text: string } {
  const actualLabel = outcomePredictionLabel(actual);
  const matched = predicted === actual;
  return {
    matched,
    text: `${matched ? '○' : '×'} ${actualLabel}`,
  };
}

/**
 * クリア時のレポートに出す1行のシステムメッセージを作る。
 * 1回も予想していないときは null を返す。括弧は使わずバッククォートで強調する。
 */
export function formatPredictionReportLine(rounds: readonly PredictionRound[]): string | null {
  const summary = summarizePredictions(rounds);
  if (summary.total === 0) return null;
  if (summary.caughtIssue) {
    return `お客さんの反応の予想は \`${summary.total}人中${summary.hits}人\` 当たり、どこで困るかも見抜けました`;
  }
  return `お客さんの反応の予想は \`${summary.total}人中${summary.hits}人\` 当たりました`;
}
