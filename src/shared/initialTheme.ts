// 使用中の題材。別の題材に差し替えるときは ACTIVE_THEME を変更する。

import type { ThemeDefinition } from './theme.ts';
import { COFFEE_BEANS_THEME } from './themes/coffeeBeans.ts';
import type { ReviewerPersona, TargetCohortId, TargetCohortInfo } from './types.ts';

export const ACTIVE_THEME: ThemeDefinition = COFFEE_BEANS_THEME;

export const TARGET_COHORTS: TargetCohortInfo[] = ACTIVE_THEME.cohorts;

export const ALL_REVIEWER_PERSONAS: ReviewerPersona[] = ACTIVE_THEME.personas;

/** 顧客層が未選択のときにレビューする代表3人 */
const INITIAL_REVIEWERS: ReviewerPersona[] = ACTIVE_THEME.defaultReviewerIds.map((id) => {
  const persona = ALL_REVIEWER_PERSONAS.find((p) => p.id === id);
  if (!persona) throw new Error(`代表レビュアーが見つかりません: ${id}`);
  return persona;
});

export function getReviewersByCohort(cohortId?: TargetCohortId): ReviewerPersona[] {
  if (!cohortId) {
    return INITIAL_REVIEWERS;
  }
  const list = ALL_REVIEWER_PERSONAS.filter((p) => p.cohortId === cohortId);
  return list.length > 0 ? list : INITIAL_REVIEWERS;
}
