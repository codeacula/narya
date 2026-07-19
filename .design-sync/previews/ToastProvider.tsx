import * as React from 'react';
import { Panel, ToastProvider, useToast } from 'streamer-tools';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, minHeight: 320 }}>{children}</div>
);

type Pushed = { kind: 'info' | 'success' | 'error'; title: string; message?: string };

// ToastProvider's own markup is the `.toast-stack` it renders *after* children,
// and that stack is only ever filled through the `useToast()` hook. A provider
// with no consumer renders an empty region, so each cell mounts a real consumer
// that pushes on mount — the same call path ServiceStatusToasts uses.
//
// `durationMs: 0` disables the 6s auto-dismiss so the stack is still on screen
// when the capture settles; the app's own calls use the default TTL.
function PushOnMount({ toasts }: { toasts: Pushed[] }) {
  const { pushToast } = useToast();
  React.useEffect(() => {
    for (const toast of toasts) pushToast({ ...toast, durationMs: 0 });
    // Mount-only: re-pushing on every render would stack duplicates forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// `.toast-stack` is `position: fixed` at the viewport's top-right (max-width
// 360px), so the children are held to the left half of the card — otherwise the
// stack lands on top of the panel header and neither reads.
const DashboardBehind = () => (
  <div style={{ maxWidth: 460 }}>
    <Panel id="controls" title="Controls" popped={false} onPop={() => undefined}>
      <div style={{ padding: 12, color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.6 }}>
        Toasts float above the dashboard in the top-right corner. The provider is
        otherwise transparent — it renders its children untouched.
      </div>
    </Panel>
  </div>
);

// The full run of kinds, as they arrive after a Settings save reconnects services.
export const ToastStack = () => (
  <Cockpit>
    <ToastProvider>
      <DashboardBehind />
      <PushOnMount
        toasts={[
          {
            kind: 'info',
            title: 'Settings saved',
            message: 'Reconnecting affected services…',
          },
          { kind: 'success', title: 'OBS connected' },
          {
            kind: 'error',
            title: 'Twitch EventSub disconnected',
            message: 'Reconnect Twitch or check the client ID/secret in Settings → Connections.',
          },
        ]}
      />
    </ToastProvider>
  </Cockpit>
);

// A single failure toast — the widest layout, since it carries a wrapped message.
export const ErrorToast = () => (
  <Cockpit>
    <ToastProvider>
      <DashboardBehind />
      <PushOnMount
        toasts={[
          {
            kind: 'error',
            title: 'Discord announcement failed',
            message: "403 Forbidden. Check the bot's Send Messages permission in #go-live.",
          },
        ]}
      />
    </ToastProvider>
  </Cockpit>
);

// Title-only success toasts — the compact form, and the resting state of the app.
export const SuccessToasts = () => (
  <Cockpit>
    <ToastProvider>
      <DashboardBehind />
      <PushOnMount
        toasts={[
          { kind: 'success', title: 'OBS connected' },
          { kind: 'success', title: 'Twitch EventSub connected' },
        ]}
      />
    </ToastProvider>
  </Cockpit>
);

// Nothing pending: the provider adds no chrome of its own.
export const Quiet = () => (
  <Cockpit>
    <ToastProvider>
      <DashboardBehind />
    </ToastProvider>
  </Cockpit>
);
