import * as React from 'react';
import { AuthGate, Panel, Chat } from 'streamer-tools';
import { CTX } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

/**
 * Only the pass-through state is reachable from a preview.
 *
 * AuthGate's token-prompt screen is latched by `reportDashboardTokenRejected()`
 * in `src/client/auth.ts`, which the dashboard's REST layer calls when the
 * server answers 401 with `INVALID_DASHBOARD_TOKEN`. That latch is module-level
 * state inside the bundled package and is not re-exported through the
 * `streamer-tools` entry, so a preview has no supported way to flip it —
 * importing `src/client/auth` relatively would bundle a *second* copy of the
 * module and set a latch that the bundled AuthGate never reads.
 *
 * So this cell shows what AuthGate does in the healthy case it is in ~always:
 * render its children with no chrome of its own.
 */
export const PassThrough = () => (
  <Cockpit>
    <AuthGate>
      <Panel id="chat" title="Chat" popped={false} onPop={() => undefined} count={CTX.chat.length}>
        <Chat ctx={CTX} />
      </Panel>
    </AuthGate>
  </Cockpit>
);
