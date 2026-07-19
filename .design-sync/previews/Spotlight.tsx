import * as React from 'react';
import { Panel, Spotlight } from 'streamer-tools';
import { CTX } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

// Spotlight resolves `login` against `ctx.viewers`. With no login it renders its
// empty state, so every populated variant must name someone in the map.
export const InPanel = () => (
  <Cockpit>
    <Panel id="spotlight" title="Spotlight" popped={false} onPop={() => undefined}>
      <Spotlight ctx={CTX} login="lanternkeeper" />
    </Panel>
  </Cockpit>
);

// A mod who subs, carries profile tags and an operator note — the fullest
// identity block the component draws.
export const Moderator = () => (
  <Cockpit>
    <div style={{ maxWidth: 420 }}>
      <Spotlight ctx={CTX} login="lanternkeeper" />
    </div>
  </Cockpit>
);

// A two-day-old account on its first message: no roles, no sub, one line of
// history. The "viewer" pill is the fallback when `roles` is empty.
export const FirstTimeViewer = () => (
  <Cockpit>
    <div style={{ maxWidth: 420 }}>
      <Spotlight ctx={CTX} login="quietmoth" />
    </div>
  </Cockpit>
);

// The Viewers page's detail pane draws its own, larger identity header, so it
// asks Spotlight to drop the avatar/name/roles block.
export const HideIdentity = () => (
  <Cockpit>
    <div style={{ maxWidth: 420 }}>
      <Spotlight ctx={CTX} login="emberwright" hideIdentity />
    </div>
  </Cockpit>
);

// Nothing focused yet — the dashboard's resting state before a name is clicked.
export const NoFocus = () => (
  <Cockpit>
    <Panel id="spotlight" title="Spotlight" popped={false} onPop={() => undefined}>
      <Spotlight ctx={CTX} />
    </Panel>
  </Cockpit>
);
