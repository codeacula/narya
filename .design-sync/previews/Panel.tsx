import * as React from 'react';
import { Panel } from 'streamer-tools';

// `.cockpit` owns the dark surface, the ivory foreground and the body font —
// every preview wraps in it, exactly as the real dashboard does.
const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

export const Default = () => (
  <Cockpit>
    <Panel id="chat" title="Chat" popped={false} onPop={() => undefined} count={128}>
      <div style={{ padding: 12, color: 'var(--fg-2)' }}>
        Panel body — any dashboard module renders in here.
      </div>
    </Panel>
  </Cockpit>
);

export const WithTabs = () => {
  const [tab, setTab] = React.useState('attention');
  return (
    <Cockpit>
      <Panel
        id="spotlight"
        title="Spotlight"
        popped={false}
        onPop={() => undefined}
        titleHidden
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          { id: 'attention', label: 'Attention', badge: 3 },
          { id: 'chatters', label: 'Chatters' },
          { id: 'shoutouts', label: 'Shoutouts' },
        ]}
      >
        <div style={{ padding: 12, color: 'var(--fg-2)' }}>
          Tab strip replaces the header title when <code>titleHidden</code> is set.
        </div>
      </Panel>
    </Cockpit>
  );
};

export const WithFooter = () => (
  <Cockpit>
    <Panel
      id="controls"
      title="Controls"
      popped={false}
      onPop={() => undefined}
      dot={false}
      footer={<span style={{ color: 'var(--fg-3)', fontSize: 11 }}>Last synced 19:14</span>}
    >
      <div style={{ padding: 12, color: 'var(--fg-2)' }}>
        A footer pins status or actions to the bottom of the panel.
      </div>
    </Panel>
  </Cockpit>
);
