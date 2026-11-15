/**
 * DOM-free decisions behind `DirtyGuardProvider` and `useDirtyGuard` (dirtyGuard.tsx),
 * kept apart so they can be unit-tested without a browser.
 */
import type { ConfirmOptions } from './confirm';

/**
 * JSON with object keys sorted, so two values built in a different key order still
 * compare equal. `undefined` properties drop out exactly as `JSON.stringify` drops
 * them, which is what makes `{ a: 1 }` and `{ a: 1, b: undefined }` the same draft.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
        sorted[key] = (inner as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return inner;
  }) ?? 'undefined';
}

/** Whether two plain-data drafts hold different values. Structural, not by reference. */
export function draftsDiffer(a: unknown, b: unknown): boolean {
  return stableStringify(a) !== stableStringify(b);
}

/**
 * Whether an editor holds unsaved work: a draft is open and it no longer matches the
 * value it was opened from (or last saved as).
 *
 * No open draft is never dirty. A draft with no baseline is treated as dirty, since
 * there is nothing to say it is safe to throw away — but editors should always pass
 * one: a new item's baseline is the blank form it opened with, so New on its own is
 * clean and the first keystroke makes it dirty.
 */
export function draftIsDirty<T>(draft: T | null | undefined, baseline: T | null | undefined): boolean {
  if (draft === null || draft === undefined) return false;
  if (baseline === null || baseline === undefined) return true;
  return draftsDiffer(draft, baseline);
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more" — duplicates collapsed. */
export function describeUnsaved(labels: readonly string[], max = 3): string {
  const unique = [...new Set(labels.map(label => label.trim()).filter(Boolean))];
  if (unique.length === 0) return 'this page';
  if (unique.length === 1) return unique[0] as string;
  if (unique.length <= max) return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
  const rest = unique.length - max;
  return `${unique.slice(0, max).join(', ')} and ${rest} more`;
}

/** The confirm raised before unsaved work is thrown away. */
export function discardPrompt(labels: readonly string[]): ConfirmOptions {
  return {
    title: 'Discard unsaved changes?',
    body: `Your changes to ${describeUnsaved(labels)} have not been saved. Leaving now throws them away.`,
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    // Danger puts initial focus on "Keep editing", so a stray Enter keeps the draft.
    tone: 'danger',
  };
}

/**
 * Which editors currently hold unsaved work, keyed by a per-editor id. `set` reports
 * whether "anything is dirty" flipped, which is when the provider attaches or removes
 * its `beforeunload` handler.
 */
export function createDirtyRegistry() {
  const entries = new Map<string, string>();
  return {
    /** Mark an editor dirty with a label, or clean with `null`. Returns true when `any()` changed. */
    set(id: string, label: string | null): boolean {
      const before = entries.size > 0;
      if (label === null) entries.delete(id);
      else entries.set(id, label);
      return before !== entries.size > 0;
    },
    any(): boolean {
      return entries.size > 0;
    },
    labels(): string[] {
      return [...entries.values()];
    },
  };
}

export type DirtyRegistry = ReturnType<typeof createDirtyRegistry>;

/**
 * Run `fn` unless the operator refuses to throw away unsaved work. With nothing in
 * `labels` it runs synchronously, so a clean click behaves exactly as an unguarded
 * one; otherwise `ask` is raised once about every label and `fn` runs on a yes.
 */
export function runUnlessRefused(
  labels: readonly string[],
  ask: (labels: string[]) => Promise<boolean>,
  fn: () => void,
): void {
  if (labels.length === 0) {
    fn();
    return;
  }
  void ask([...labels]).then(ok => { if (ok) fn(); });
}

/**
 * A filtered list that never drops an item whose editor is open. Cards keep their
 * draft in their own state, so a filter that unmounts one (typing in Find, switching
 * "Show hidden" off, hiding the card being edited) throws the draft away — and the
 * unmount reports the editor clean, so nothing asks first. An open editor stays in
 * the list whatever the filter says, in its original position.
 */
export function keepOpenInView<T, K>(
  items: readonly T[],
  matches: (item: T) => boolean,
  open: ReadonlySet<K>,
  idOf: (item: T) => K,
): T[] {
  return items.filter(item => open.has(idOf(item)) || matches(item));
}
