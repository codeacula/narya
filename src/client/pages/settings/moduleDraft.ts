import type { CategoryModuleInput } from '../../../shared/api';
import { draftIsDirty } from '../../ui/dirtyGuardLogic';

/**
 * A module draft with its two lists put in one order. Both are sets to the server
 * (`category_module_games.game_id` is a primary key; reward groups are de-duplicated
 * by `normalizeRewardGroupIds`), but the editor appends: untick a reward group and
 * tick it again and it moves to the end, remove a category and add it back and the
 * same happens. Compared raw, that read as an unsaved edit with the very same set.
 */
export function canonicalModuleDraft(draft: CategoryModuleInput): CategoryModuleInput {
  return {
    ...draft,
    games: [...draft.games].sort((a, b) => a.id.localeCompare(b.id)),
    rewardGroupIds: [...draft.rewardGroupIds].sort(),
  };
}

/** Whether the module editor holds unsaved work, ignoring the order of its sets. */
export function moduleDraftDirty(
  draft: CategoryModuleInput | null,
  baseline: CategoryModuleInput | null,
): boolean {
  return draftIsDirty(
    draft ? canonicalModuleDraft(draft) : draft,
    baseline ? canonicalModuleDraft(baseline) : baseline,
  );
}
