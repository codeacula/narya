import type { RefreshHealth } from '../../refreshHealth';

/**
 * Which face a loaded-once settings list shows. Kept apart from the pages so the rule
 * is testable without a renderer.
 *
 * The rule this exists for: **a list that failed to load is not empty.** Every page
 * used to start from `[]`, so a failed GET fell straight through to "No triggers yet"
 * or "Create first reward" — inviting the operator to recreate configuration that
 * was there all along. A failed load now shows `ListUnavailable` (shared.tsx) instead,
 * and the empty face is kept for a list the server actually returned empty.
 *
 * - With no rows, a failed load is `unavailable` — and stays so while its Retry is in
 *   flight. Swapping to `loading` there unmounted the Retry button the operator had
 *   just pressed, dropping keyboard focus to the page body; `ListUnavailable` shows the
 *   retry in progress on that same button instead.
 * - Otherwise `loading` wins, as it already did on every page: nothing is known yet.
 * - Rows on screen always show (`items`), even after a later refresh failed — those
 *   are real rows, and the failure is reported beside them.
 * - With no rows, only a successful load is `empty`.
 */
export type ListFace = 'loading' | 'items' | 'unavailable' | 'empty';

export function listFace({
  loading,
  loadFailed,
  count,
}: {
  loading: boolean;
  /** True from a failed load until the next successful one. */
  loadFailed: boolean;
  count: number;
}): ListFace {
  if (loadFailed && count === 0) return 'unavailable';
  if (loading) return 'loading';
  return count > 0 ? 'items' : 'empty';
}

/**
 * The state of a list loaded once for a picker (rewards for a reward trigger, apps for
 * a redis_event trigger). `[]` alone cannot say whether the list is empty, still in
 * flight, or failed, and only the first of those may be described as "none".
 */
export type PickerLoad =
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'failed'; error: string };

export const PICKER_LOADING: PickerLoad = { status: 'loading' };

/** Whether `[]` from this load may be read as "there are none". */
export function pickerConfirmedEmpty(load: PickerLoad, count: number): boolean {
  return load.status === 'loaded' && count === 0;
}

/** An error message as a sentence, so another sentence can follow it. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * For a list kept fresh by a background refresh (`useRefreshHealth`): true while it
 * has never loaded and the last attempt failed. `StaleNotice` covers a list that
 * loaded once and then went stale; this is the other half, where there is nothing on
 * screen to mark stale and an empty face would be a false "none".
 */
export function neverLoaded(health: RefreshHealth): boolean {
  return health.lastSuccessAt === null && health.consecutiveFailures > 0;
}
