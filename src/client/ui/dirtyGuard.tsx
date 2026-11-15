import React from 'react';
import { useConfirm } from './confirm';
import { createDirtyRegistry, discardPrompt, draftIsDirty } from './dirtyGuardLogic';

/**
 * The unsaved-edit guard: one place that knows whether any editor on the page holds
 * work that has not been saved, and asks before that work is thrown away.
 *
 * - An editor reports itself with `useDirtyGuard(isDirty, label)`. `label` names what
 *   would be lost ("the action \"Raid hype\""), and the confirm lists every dirty one.
 *   The returned `discardThen(fn)` gates the editor's own switches (picking another
 *   row, New, Close) behind the same confirm, and runs `fn` at once when clean.
 * - A navigator (the settings rail, the top nav, browser back/forward) calls
 *   `useLeaveGuard().confirmLeave()` and only moves on a `true`.
 * - While anything is dirty a `beforeunload` handler is attached, so closing or
 *   reloading the tab (or following an OAuth link) gets the browser's own prompt. It
 *   is removed again as soon as the last editor is clean, which keeps the page
 *   eligible for the back/forward cache the rest of the time.
 *
 * `useDraft` is the usual way to compute `isDirty` honestly: it keeps the value a draft
 * was opened from (or last saved as) next to the draft, so a draft is dirty only while
 * it differs — not right after a save, and not after typing back to the saved value.
 *
 * Mounted once in `main.tsx`, inside `ConfirmProvider`, around the dashboard.
 */

type DirtyGuardApi = {
  setDirty: (id: string, label: string | null) => void;
  isDirty: () => boolean;
  /** Ask about the given labels. Resolves false without asking if a prompt is already open. */
  ask: (labels: string[]) => Promise<boolean>;
  /** Resolves true when nothing is dirty, else asks about everything that is. */
  confirmLeave: () => Promise<boolean>;
};

const DirtyGuardContext = React.createContext<DirtyGuardApi | null>(null);

function holdUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Older Chromium only shows the prompt when returnValue is set.
  event.returnValue = '';
}

export function DirtyGuardProvider({ children }: { children: React.ReactNode }) {
  const confirm = useConfirm();
  const registryRef = React.useRef(createDirtyRegistry());
  const promptOpenRef = React.useRef(false);

  const api = React.useMemo<DirtyGuardApi>(() => {
    const registry = registryRef.current;
    const ask = async (labels: string[]) => {
      // One question at a time: a browser Back pressed while the confirm is up must
      // not stack a second prompt behind it.
      if (promptOpenRef.current) return false;
      promptOpenRef.current = true;
      try {
        return await confirm(discardPrompt(labels));
      } finally {
        promptOpenRef.current = false;
      }
    };
    return {
      setDirty(id, label) {
        if (!registry.set(id, label)) return;
        if (registry.any()) window.addEventListener('beforeunload', holdUnload);
        else window.removeEventListener('beforeunload', holdUnload);
      },
      isDirty: () => registry.any(),
      ask,
      confirmLeave: () => (registry.any() ? ask(registry.labels()) : Promise.resolve(true)),
    };
  }, [confirm]);

  React.useEffect(() => () => window.removeEventListener('beforeunload', holdUnload), []);

  return <DirtyGuardContext.Provider value={api}>{children}</DirtyGuardContext.Provider>;
}

function useDirtyGuardApi(): DirtyGuardApi {
  const api = React.useContext(DirtyGuardContext);
  if (!api) throw new Error('The unsaved-edit guard needs a <DirtyGuardProvider> above it (see main.tsx).');
  return api;
}

/**
 * Report whether this editor holds unsaved work. Returns guards for the editor's own
 * in-page switches: `confirmDiscard()` resolves true when clean or when the operator
 * agrees to discard, and `discardThen(fn)` runs `fn` on that answer.
 */
export function useDirtyGuard(isDirty: boolean, label: string) {
  const api = useDirtyGuardApi();
  const id = React.useId();
  const dirtyRef = React.useRef(isDirty);
  const labelRef = React.useRef(label);
  dirtyRef.current = isDirty;
  labelRef.current = label;

  React.useEffect(() => {
    api.setDirty(id, isDirty ? label : null);
  }, [api, id, isDirty, label]);
  // An editor that unmounts (its section was left, its card removed) is no longer
  // holding anything, whatever it last reported.
  React.useEffect(() => () => api.setDirty(id, null), [api, id]);

  const confirmDiscard = React.useCallback(
    () => (dirtyRef.current ? api.ask([labelRef.current]) : Promise.resolve(true)),
    [api],
  );
  const discardThen = React.useCallback((fn: () => void) => {
    // Clean runs synchronously, so an unguarded click behaves exactly as before.
    if (!dirtyRef.current) {
      fn();
      return;
    }
    void confirmDiscard().then(ok => { if (ok) fn(); });
  }, [confirmDiscard]);

  return { confirmDiscard, discardThen };
}

/** For navigators: whether anything is dirty, and the confirm to raise before leaving. */
export function useLeaveGuard() {
  const api = useDirtyGuardApi();
  return { isDirty: api.isDirty, confirmLeave: api.confirmLeave };
}

/**
 * A draft plus the value it was opened from. `resetDraft(value)` sets both — call it
 * when opening an item, after a save lands, and when closing (`resetDraft(null)` for a
 * nullable draft) — and `setDraft` for edits. `dirty` is true only while they differ.
 */
export function useDraft<T>(initial: T) {
  const [draft, setDraft] = React.useState<T>(initial);
  const [baseline, setBaseline] = React.useState<T>(initial);
  const resetDraft = React.useCallback((value: T) => {
    setDraft(value);
    setBaseline(value);
  }, []);
  return { draft, setDraft, baseline, resetDraft, dirty: draftIsDirty(draft, baseline) };
}
