import * as React from 'react';
import { Chat, Panel } from 'streamer-tools';
import { CTX } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

// Chat is a module body, not a standalone surface — the true composition is
// inside the Panel that hosts it on the dashboard.
export const InPanel = () => (
  <Cockpit>
    <Panel id="chat" title="Chat" popped={false} onPop={() => undefined} count={CTX.chat.length}>
      <Chat ctx={CTX} />
    </Panel>
  </Cockpit>
);

export const Bare = () => (
  <Cockpit>
    <div style={{ height: 260 }}>
      <Chat ctx={CTX} />
    </div>
  </Cockpit>
);

// The pre-stream state: a connected channel with nothing said yet.
export const Empty = () => (
  <Cockpit>
    <Panel id="chat" title="Chat" popped={false} onPop={() => undefined} count={0}>
      <Chat ctx={{ ...CTX, chat: [] }} />
    </Panel>
  </Cockpit>
);
