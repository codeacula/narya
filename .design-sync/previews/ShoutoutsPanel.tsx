import * as React from 'react';
import { Panel, ShoutoutsPanel } from 'streamer-tools';
import type { SessionShoutout } from '../../src/shared/api';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

// Never a fixed ISO string — a stale `firstAt` would read as a stream that
// started years ago. Everything is anchored to now, like the real feed.
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// GET /api/dashboard/session-shoutouts groups the current session's
// thank-worthy events per actor, so one viewer carries every kind they hit.
const SHOUTOUTS: SessionShoutout[] = [
  {
    actor: 'LanternKeeper',
    login: 'lanternkeeper',
    kinds: ['raid', 'sub', 'cheer'],
    detail: '42 viewers · Tier 1 · 500 bits',
    firstAt: minutesAgo(46),
    lastAt: minutesAgo(4),
  },
  {
    actor: 'Emberwright',
    login: 'emberwright',
    kinds: ['sub', 'gift'],
    detail: 'Tier 1 · 3 months · gifted 5',
    firstAt: minutesAgo(31),
    lastAt: minutesAgo(12),
  },
  {
    actor: 'quietmoth',
    login: 'quietmoth',
    kinds: ['follow'],
    detail: '',
    firstAt: minutesAgo(9),
    lastAt: minutesAgo(9),
  },
  {
    actor: 'brasslantern',
    login: 'brasslantern',
    kinds: ['cheer', 'redeem'],
    detail: '1200 bits · Pick the next refactor',
    firstAt: minutesAgo(23),
    lastAt: minutesAgo(2),
  },
  {
    actor: 'Nightjar_TTV',
    login: 'nightjar_ttv',
    kinds: ['follow', 'cheer'],
    detail: '100 bits',
    firstAt: minutesAgo(18),
    lastAt: minutesAgo(17),
  },
];

// The Shoutouts tab of the Spotlight panel, mid-stream.
export const InPanel = () => (
  <Cockpit>
    <Panel
      id="spotlight"
      title="Shoutouts"
      popped={false}
      onPop={() => undefined}
      count={SHOUTOUTS.length}
    >
      <ShoutoutsPanel shoutouts={SHOUTOUTS} streamActive onOpenViewer={() => undefined} />
    </Panel>
  </Cockpit>
);

// Live, but nothing thank-worthy has landed yet this session.
export const NobodyYet = () => (
  <Cockpit>
    <Panel id="spotlight" title="Shoutouts" popped={false} onPop={() => undefined} count={0}>
      <ShoutoutsPanel shoutouts={[]} streamActive onOpenViewer={() => undefined} />
    </Panel>
  </Cockpit>
);

// Off-stream: shoutouts are session-scoped, so there is nothing to collect into.
export const Offline = () => (
  <Cockpit>
    <Panel id="spotlight" title="Shoutouts" popped={false} onPop={() => undefined} dot={false}>
      <ShoutoutsPanel shoutouts={[]} streamActive={false} onOpenViewer={() => undefined} />
    </Panel>
  </Cockpit>
);
