import React from 'react';
import { isDashboardTokenRejected, onDashboardTokenRejected, setDashboardToken } from '../auth';

/**
 * Stands in front of the operator pages once the server has rejected this
 * browser's dashboard token.
 *
 * Without it, a stale token is close to undiagnosable: every panel independently
 * renders "Unauthorized", and the stat bar reports "Twitch login required" —
 * because the Twitch *status* call is 401ing too — so a perfectly good Twitch
 * login looks like the thing that failed. Say what actually happened, and let the
 * operator paste the token rather than having to know about `?token=`.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [rejected, setRejected] = React.useState(isDashboardTokenRejected);

  React.useEffect(() => {
    const unsubscribe = onDashboardTokenRejected(() => setRejected(true));
    // The latch can flip between our initial render and this effect. A child panel's
    // fetch effect runs before ours (effects fire child-first) and can reject the token
    // synchronously — a token the browser cannot even place in a header does so on the
    // very first request — firing the notification before we subscribed. Reconcile once
    // here so that missed signal still raises the gate.
    if (isDashboardTokenRejected()) setRejected(true);
    return unsubscribe;
  }, []);

  if (!rejected) return <>{children}</>;
  return <TokenPrompt />;
}

function TokenPrompt() {
  const [token, setToken] = React.useState('');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setDashboardToken(trimmed);
    // Full reload rather than a re-render: the WebSocket and every panel's initial
    // fetch were all built against the rejected token.
    window.location.reload();
  }

  return (
    <div className="auth-gate">
      <form className="auth-gate-card" onSubmit={submit}>
        <div className="auth-gate-title">Dashboard token required</div>
        <p className="auth-gate-body">
          The server rejected this browser&apos;s dashboard token, so every request comes back
          Unauthorized — including the Twitch connection status, which is why the dashboard may claim
          Twitch is not logged in even when it is.
        </p>
        <p className="auth-gate-body">
          Paste the <code>DASHBOARD_TOKEN</code> from the server&apos;s <code>.env</code>, or open the
          dashboard once with <code>?token=…</code> appended to the URL.
        </p>
        <input
          className="auth-gate-input"
          type="password"
          value={token}
          onChange={event => setToken(event.target.value)}
          placeholder="DASHBOARD_TOKEN"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <button className="btn-primary" type="submit" disabled={!token.trim()}>Unlock dashboard</button>
      </form>
    </div>
  );
}
