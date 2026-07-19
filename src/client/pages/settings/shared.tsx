import React, { useEffect, useRef, useState } from 'react';
import type { SettingsRoute } from '../../routing';
import { settingsSection } from './sections';
import { errorMessage } from '../../errors';

/**
 * The header every settings section shares. Eyebrow, title, and intro come from the
 * section registry rather than each page, so the rail entry and the page it opens can
 * never disagree about what the section is called.
 */
export function SettingsHeader({
  section,
  meta,
  actions,
}: {
  section: SettingsRoute;
  /** A line of live detail under the intro — a count, a state. Optional. */
  meta?: React.ReactNode;
  /** The section's primary control, e.g. "New action". Optional. */
  actions?: React.ReactNode;
}) {
  const { group, title, blurb } = settingsSection(section);
  return (
    <header className="set-head">
      <div className="set-head-main">
        <div className="settings-eyebrow">{group}</div>
        <h2 className="settings-title">{title}</h2>
        <p className="set-intro">{blurb}</p>
        {meta}
      </div>
      {actions ? <div className="set-head-actions">{actions}</div> : null}
    </header>
  );
}

/**
 * The one line of feedback a settings form gives after a load or a save. An error wins
 * over a message, and takes the `error` modifier with it; with neither, nothing renders.
 */
export function SettingsStatus({
  message,
  error,
}: {
  message?: React.ReactNode;
  error?: React.ReactNode;
}) {
  if (!message && !error) return null;
  return <div className={'command-settings-status' + (error ? ' error' : '')}>{error ?? message}</div>;
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
      <div style={{ flex: 1, minWidth: 0 }}>
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
}: {
  initial: T;
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

  const submit = (next: T, successMessage: string) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    void save(next)
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

  return {
    value,
    setValue,
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
