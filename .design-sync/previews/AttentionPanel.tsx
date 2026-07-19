import * as React from 'react';
import { AttentionPanel, Panel } from 'streamer-tools';
import { ATTENTION_ITEMS, ATTENTION_SETTINGS } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

const noop = () => undefined;

// The live case: everything is unacked, so every row carries the highlight.
export const InPanel = () => (
  <Cockpit>
    <Panel
      id="spotlight"
      title="Attention"
      popped={false}
      onPop={noop}
      count={ATTENTION_ITEMS.length}
    >
      <AttentionPanel
        items={ATTENTION_ITEMS}
        acked={new Set<string>()}
        settings={ATTENTION_SETTINGS}
        onAck={noop}
        onSettingsChange={noop}
      />
    </Panel>
  </Cockpit>
);

// Acked rows drop the highlight but stay in the feed, so the operator can still
// see who they already thanked this session.
export const PartlyAcknowledged = () => (
  <Cockpit>
    <Panel id="spotlight" title="Attention" popped={false} onPop={noop} count={2}>
      <AttentionPanel
        items={ATTENTION_ITEMS}
        acked={new Set(['e2', 'e3', 'e4', 'e5'])}
        settings={ATTENTION_SETTINGS}
        onAck={noop}
        onSettingsChange={noop}
      />
    </Panel>
  </Cockpit>
);

export const Bare = () => (
  <Cockpit>
    <div style={{ maxWidth: 420 }}>
      <AttentionPanel
        items={ATTENTION_ITEMS}
        acked={new Set(['e4'])}
        settings={ATTENTION_SETTINGS}
        onAck={noop}
        onSettingsChange={noop}
      />
    </div>
  </Cockpit>
);

// Caught up: the toolbar hint switches from "click an item" to "nothing waiting".
export const NothingWaiting = () => (
  <Cockpit>
    <Panel id="spotlight" title="Attention" popped={false} onPop={noop} count={0}>
      <AttentionPanel
        items={[]}
        acked={new Set<string>()}
        settings={ATTENTION_SETTINGS}
        onAck={noop}
        onSettingsChange={noop}
      />
    </Panel>
  </Cockpit>
);
