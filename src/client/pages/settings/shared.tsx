import React, { useEffect, useRef, useState } from 'react';
import type { SettingsRoute } from '../../routing';
import { settingsSection } from './sections';
import { errorMessage } from '../../errors';
import { useDirtyGuard } from '../../ui/dirtyGuard';
import { draftsDiffer } from '../../ui/dirtyGuardLogic';
import { headerCountParts, type HeaderCount } from './headerCounts';
import { EmptyState, type EmptyStateSize } from '../../ui/emptyState';

/**
 * The header every settings section shares — the only header a section renders.
 * Eyebrow, title, and intro come from the section registry rather than each page, so the
 * rail entry and the page it opens can never disagree about what the section is called.
 *
 * What a section may add is data, not markup, so every header is set the same way:
 * - `counts` — the mono count line under the intro ("3 counters", "12 saved · 2 hidden").
 * - `actions` — the section's one primary control, top right. Pass a `btn-primary`; a
 *   split editor's "New" belongs in its list column, not here.
 */
export function SettingsHeader({
  section,
  counts,
  actions,
}: {
  section: SettingsRoute;
  counts?: ReadonlyArray<HeaderCount>;
  actions?: React.ReactNode;
}) {
  const { group, title, blurb } = settingsSection(section);
  const parts = counts ? headerCountParts(counts) : [];
  return (
    <header className="set-head">
      <div className="set-head-main">
        <div className="settings-eyebrow">{group}</div>
        <h2 className="settings-title">{title}</h2>
        <p className="set-intro">{blurb}</p>
        {parts.length > 0 ? (
          <p className="set-head-meta">
            {parts.map((part, index) => (
              <React.Fragment key={part.label}>
                {index > 0 ? <span className="set-head-meta-dot" aria-hidden="true" /> : null}
                <span><b>{part.value}</b> {part.label}</span>
              </React.Fragment>
            ))}
          </p>
        ) : null}
      </div>
      {actions ? <div className="set-head-actions">{actions}</div> : null}
    </header>
  );
}

/**
 * The one line of feedback a settings form gives after a load or a save. An error wins
 * over a message, and takes the `error` modifier with it; with neither, nothing shows.
 *
 * The feedback rule, so the next page does not grow a sixth pattern:
 * - A save, delete or load on a settings page reports here, beside the form that did
 *   it. Do not hand-roll a banner class for it.
 * - Toasts are for global or background events nobody is looking at a form for
 *   (a service dropped, a broadcast arrived, an announcement failed).
 * - The viewers roster (`viewers-status`) and a viewer's record actions
 *   (`viewer-record-note`) keep their own quieter styling, tuned to the roster. They
 *   are live regions too.
 * - A background refresh that fails says so with `StaleNotice`, not here: this line
 *   is about what the operator just did.
 */
export function SettingsStatus({
  message,
  error,
}: {
  message?: React.ReactNode;
  error?: React.ReactNode;
}) {
  const shown = error || message || null;
  // Announced through two live regions that are ALWAYS mounted, even with nothing to
  // say. A region inserted together with its text is often not announced at all —
  // screen readers watch regions that already exist for changes — so returning null
  // when empty silently swallowed every "Saved". Both are `sr-only`, which takes them
  // out of flow: an empty one adds no gap to the grid or flex column it sits in.
  // The drawn line is `aria-hidden` so the outcome is read once, not twice.
  return (
    <>
      <div className="sr-only" role="status">{error ? null : message}</div>
      <div className="sr-only" role="alert">{error}</div>
      {shown ? (
        <div className={'command-settings-status' + (error ? ' error' : '')} aria-hidden="true">
          {shown}
        </div>
      ) : null}
    </>
  );
}

/**
 * What a settings list shows when it could not be loaded (`listFace` → `unavailable`,
 * listState.ts) — never the list's own empty state, which would invite the operator
 * to recreate what is already there. `title` names the state ("Triggers
 * unavailable"); the error itself is already on the page's `SettingsStatus` line, so
 * it is not repeated here. `onRetry` adds the one control that can end the state.
 */
export function ListUnavailable({
  title,
  size = 'panel',
  onRetry,
}: {
  title: string;
  size?: EmptyStateSize;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      size={size}
      title={title}
      action={onRetry ? <button className="modbtn" type="button" onClick={onRetry}>Retry</button> : undefined}
    >
      Narya could not load them, so this is not an empty list. Nothing was changed.
    </EmptyState>
  );
}

/** A section header whose title carries the switch that enables the whole section. */
export function SettingsToggleLabel({
  label,
  toggleLabel,
  checked,
  disabled,
  onChange,
}: {
  label: React.ReactNode;
  /** Accessible name for the switch — the visible label is the section title. */
  toggleLabel: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="set-group-label set-group-label--toggle">
      <span>{label}</span>
      <input
        className="set-group-toggle"
        type="checkbox"
        aria-label={toggleLabel}
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
    </div>
  );
}

export function SettingsRow({
  label,
  sub,
  children,
}: {
  label: React.ReactNode;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-label">{label}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/**
 * The load/save skeleton a settings section repeats: the form value, the last value the
 * server confirmed, and the loading/saving/message/error quartet the form renders from.
 *
 * A failed save restores the value as it stood when the handler was created, so `submit`
 * is deliberately not memoized — memoizing it would freeze that rollback on a stale value.
 */
export function useSettingsForm<T>({
  initial,
  load,
  loadError,
  save,
  saveError,
  unsavedLabel,
}: {
  initial: T;
  /**
   * What the unsaved-edit guard calls this form ("the wind-down schedule"). Required
   * so no section built on this hook can lose an edit silently.
   */
  unsavedLabel: string;
  /**
   * Resolves the value to show. `cancelled()` reports whether the section has unmounted —
   * check it before any setState of your own, as the hook does for its own state.
   */
  load: (cancelled: () => boolean) => Promise<T>;
  loadError: string;
  save: (value: T) => Promise<T>;
  saveError: string;
}) {
  const [value, setValue] = useState<T>(initial);
  // Last value the server confirmed; an enable toggle saves from this so it never
  // commits unsaved form edits.
  const confirmed = useRef<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load(() => cancelled)
      .then(loaded => {
        if (!cancelled) {
          confirmed.current = loaded;
          setValue(loaded);
          setError(null);
        }
      })
      .catch(caught => {
        if (!cancelled) setError(errorMessage(caught, loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  /**
   * Returns the in-flight save so a caller can sequence work after the server has
   * committed the value — the TTS enable toggle probes the service only once
   * `enabled: true` is persisted, or the probe races the PUT and sees it still off.
   * The promise always resolves (failures surface through `error`), so the existing
   * fire-and-forget callers are unaffected by the added return.
   */
  const submit = (next: T, successMessage: string): Promise<void> => {
    setSaving(true);
    setMessage(null);
    setError(null);
    return save(next)
      .then(saved => {
        confirmed.current = saved;
        setValue(saved);
        setMessage(successMessage);
      })
      .catch(caught => {
        setValue(value);
        setError(errorMessage(caught, saveError));
      })
      .finally(() => setSaving(false));
  };

  // Dirty only once something has loaded: before that the form shows `initial`, and an
  // edit cannot have happened because every field is disabled while loading.
  const dirty = confirmed.current !== null && draftsDiffer(value, confirmed.current);
  const { discardThen } = useDirtyGuard(dirty, unsavedLabel);

  return {
    value,
    setValue,
    /** True while the form differs from the last value the server confirmed. */
    dirty,
    /** Runs `fn` now when clean, or after the operator agrees to discard the edits. */
    discardThen,
    /** The last server-confirmed value, or the current form value before the first load. */
    confirmed: confirmed.current ?? value,
    loading,
    saving,
    message,
    error,
    setMessage,
    setError,
    submit,
  };
}
