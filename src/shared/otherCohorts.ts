// 選ばなかった客層のお客さんが、今の画面でどうなるかを1行にまとめる。
// 誰のために直したかで別の誰かが困ることを、その場で見せるために使う。判定はコードだけで行い、AIは呼ばない

import { simulatePersonaComputerUse } from './sandboxValidator.ts';
import type { AppSpec, ComponentBoundsInput, ReviewerPersona, ReviewOutcome } from './types.ts';

const MAX_NAMED = 2;

const OUTCOME_ENDINGS: Record<Exclude<ReviewOutcome, 'achieved'>, { middle: string; last: string }> = {
  abandoned: { middle: '離脱し', last: '離脱しました' },
  regretted: { middle: '後悔し', last: '後悔しました' },
  bothered: { middle: '不満が残り', last: '不満が残りました' },
};

export interface OtherCohortImpact {
  total: number;
  achieved: number;
  unhappy: Array<{ name: string; outcome: Exclude<ReviewOutcome, 'achieved'>; reason: string }>;
  line: string;
}

/**
 * 選ばなかった客層のお客さん（otherPersonas）を今の画面で操作させ、結果を1行の文にする。
 * 括弧は使わず、名前と理由はバッククォートで囲む（チャットではインラインコードとして表示される）
 */
export function describeOtherCohortImpact(
  spec: AppSpec,
  otherPersonas: ReviewerPersona[],
  bounds?: ComponentBoundsInput[],
): OtherCohortImpact {
  const unhappy: OtherCohortImpact['unhappy'] = [];
  for (const persona of otherPersonas) {
    const result = simulatePersonaComputerUse(spec, persona, bounds);
    if (result.outcome === 'achieved') continue;
    unhappy.push({
      name: persona.name,
      outcome: result.outcome,
      reason: result.frictionPoint ?? '理由が分からない',
    });
  }

  const total = otherPersonas.length;
  const achieved = total - unhappy.length;
  if (unhappy.length === 0) {
    return { total, achieved, unhappy, line: `ほかの客層のお客さん \`${total}人\` も、この画面で気持ちよく買えます` };
  }

  const named = unhappy.slice(0, MAX_NAMED);
  const clauses = named.map((u, i) => {
    const ending = OUTCOME_ENDINGS[u.outcome];
    return `\`${u.name}\` が \`${u.reason}\` ため${i === named.length - 1 ? ending.last : ending.middle}`;
  });
  let line = `ほかの客層では、${clauses.join('、')}`;
  const rest = unhappy.length - named.length;
  if (rest > 0) line += `。ほかにも \`${rest}人\` が満足していません`;
  return { total, achieved, unhappy, line };
}
