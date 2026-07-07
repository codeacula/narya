import React from 'react';

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
