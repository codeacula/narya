import * as React from 'react';
import { Panel, ServiceStatusToasts, ToastProvider } from 'streamer-tools';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, minHeight: 320 }}>{children}</div>
);

/**
 * ServiceStatusToasts `return null` — it has no markup of its own.
 *
 * Its entire visible output is toasts it pushes into `ToastProvider` from three
 * WebSocket subscriptions (`dashboard:status`, `settings:updated`,
 * `discord:announce-failed`). `dashboard:status` additionally reports only
 * *transitions*, so even a live socket needs two snapshots before the first
 * toast appears.
 *
 * The preview harness serves static files with no `/socket` endpoint, so no
 * payload can reach it and this cell renders the surrounding dashboard with an
 * empty toast region. That is the component's honest static appearance — see
 * ToastProvider's previews for what it renders once an event lands. Faking a
 * socket or hand-writing the toast markup would show something the component
 * did not produce.
 */
export const Mounted = () => (
  <Cockpit>
    <ToastProvider>
      <ServiceStatusToasts />
      <Panel id="service-status" title="Service status" popped={false} onPop={() => undefined}>
        <div style={{ padding: 12, color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.6 }}>
          <code style={{ color: 'var(--gold-400)' }}>&lt;ServiceStatusToasts /&gt;</code> is
          mounted once inside <code style={{ color: 'var(--gold-400)' }}>ToastProvider</code> and
          renders <code style={{ color: 'var(--gold-400)' }}>null</code>. It watches OBS and Twitch
          EventSub connectivity over the shared WebSocket and pushes a toast on each transition.
        </div>
      </Panel>
    </ToastProvider>
  </Cockpit>
);
