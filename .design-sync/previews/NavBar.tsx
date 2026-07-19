import * as React from 'react';
import { NavBar } from 'streamer-tools';
import { CHANNEL } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 0, height: 'auto' }}>{children}</div>
);

const base = {
  setPage: () => undefined,
  onTweaksToggle: () => undefined,
  channel: CHANNEL,
};

// The top nav is three fixed destinations — every settings section lives behind
// the one `settings` link, so `page` only ever lights one of the three.
export const OnDashboard = () => (
  <Cockpit>
    <NavBar {...base} page="dashboard" tweaksOpen={false} />
  </Cockpit>
);

export const OnViewers = () => (
  <Cockpit>
    <NavBar {...base} page="viewers" tweaksOpen={false} />
  </Cockpit>
);

// `settings` stays lit for every section route behind it — `actions` is one of them.
export const OnSettingsWithTweaksOpen = () => (
  <Cockpit>
    <NavBar {...base} page="actions" tweaksOpen />
  </Cockpit>
);

// `alert` is the AutoMod held-message badge the dashboard hands in when the
// review queue is non-empty; it sits between the spacer and the icon buttons.
export const WithAutomodAlert = () => (
  <Cockpit>
    <NavBar
      {...base}
      page="dashboard"
      tweaksOpen={false}
      alert={
        <button className="nav-automod-alert" title="Held messages awaiting review">
          <span className="nav-automod-dot" aria-hidden="true" />
          3 held
        </button>
      }
    />
  </Cockpit>
);
