import React from 'react';
import type { SettingsRoute } from '../../routing';
import { settingsSection } from './sections';

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
