import * as React from 'react';
import { ChattersPanel, Panel } from 'streamer-tools';
import { CHATTERS, VIEWERS } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

// Rows sort by role — broadcaster, mods, VIPs, subs, then everyone else
// alphabetically — and take their colour and badges from the viewer map.
export const InPanel = () => (
  <Cockpit>
    <Panel
      id="chatters"
      title="Chatters"
      popped={false}
      onPop={() => undefined}
      count={CHATTERS.length}
    >
      <ChattersPanel
        chatters={CHATTERS}
        viewers={VIEWERS}
        error=""
        onOpenViewer={() => undefined}
      />
    </Panel>
  </Cockpit>
);

export const Bare = () => (
  <Cockpit>
    <div style={{ maxWidth: 320 }}>
      <ChattersPanel
        chatters={CHATTERS}
        viewers={VIEWERS}
        error=""
        onOpenViewer={() => undefined}
      />
    </div>
  </Cockpit>
);

// Presence lags an empty room at the top of a stream.
export const Empty = () => (
  <Cockpit>
    <Panel id="chatters" title="Chatters" popped={false} onPop={() => undefined} count={0}>
      <ChattersPanel chatters={[]} viewers={VIEWERS} error="" onOpenViewer={() => undefined} />
    </Panel>
  </Cockpit>
);

// A missing scope gets its own copy telling the operator how to fix it, rather
// than surfacing the raw Helix message.
export const MissingScope = () => (
  <Cockpit>
    <Panel id="chatters" title="Chatters" popped={false} onPop={() => undefined}>
      <ChattersPanel
        chatters={[]}
        viewers={VIEWERS}
        error="missing scope: moderator:read:chatters"
        onOpenViewer={() => undefined}
      />
    </Panel>
  </Cockpit>
);
