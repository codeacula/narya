import * as React from 'react';
import { AttentionDismissAll, AttentionPanel, Panel } from 'streamer-tools';
import { ATTENTION_ITEMS, ATTENTION_SETTINGS } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

const noop = () => undefined;

// AttentionDismissAll is a header action, not a standalone control — its real
// home is the Attention panel's header, clearing the feed rendered beneath it.
export const InPanelHeader = () => {
  const [acked, setAcked] = React.useState<Set<string>>(new Set());
  const unacked = ATTENTION_ITEMS.filter(i => !acked.has(i.id));
  return (
    <Cockpit>
      <Panel
        id="spotlight"
        title="Attention"
        popped={false}
        onPop={noop}
        count={unacked.length}
        headerActions={
          <AttentionDismissAll
            disabled={unacked.length === 0}
            onDismiss={() => setAcked(new Set(ATTENTION_ITEMS.map(i => i.id)))}
          />
        }
      >
        <AttentionPanel
          items={ATTENTION_ITEMS}
          acked={acked}
          settings={ATTENTION_SETTINGS}
          onAck={id => setAcked(prev => new Set(prev).add(id))}
          onSettingsChange={noop}
        />
      </Panel>
    </Cockpit>
  );
};

// Nothing left to clear: the button disables rather than disappearing, so the
// header does not reflow every time the feed empties.
export const Disabled = () => (
  <Cockpit>
    <Panel
      id="spotlight"
      title="Attention"
      popped={false}
      onPop={noop}
      count={0}
      headerActions={<AttentionDismissAll disabled onDismiss={noop} />}
    >
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

// The control on its own, both states side by side.
export const States = () => (
  <Cockpit>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <AttentionDismissAll disabled={false} onDismiss={noop} />
      <AttentionDismissAll disabled onDismiss={noop} />
    </div>
  </Cockpit>
);
