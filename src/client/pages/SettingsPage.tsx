import type React from 'react';
import type { DashboardStatus } from '../../shared/api';

export type DashboardTweaks = {
  layout: string;
  density: string;
  clock: string;
  accent: string;
  starfield: boolean;
};

export function SettingsPage({
  t,
  setTweak,
  status,
  onTwitchLogout,
}: {
  t: DashboardTweaks;
  setTweak: <K extends keyof DashboardTweaks>(k: K, v: DashboardTweaks[K]) => void;
  status: DashboardStatus;
  onTwitchLogout: () => void;
}) {
  const missingTwitchScopes = status.twitchMissingScopes.length > 0
    ? status.twitchMissingScopes.join(', ')
    : null;
  const twitchLoginSub = missingTwitchScopes
    ? `Reconnect to grant missing scopes: ${missingTwitchScopes}`
    : status.twitchAuthenticated
      ? `Credentials cached on backend${status.twitchAuthSource ? ` via ${status.twitchAuthSource}` : ''}`
      : 'Login to cache credentials for EventSub, Twitch uptime, and ad schedule data';

  const Row = ({
    label,
    sub,
    children,
  }: {
    label: string;
    sub?: string;
    children: React.ReactNode;
  }) => (
    <div className="set-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="set-label">{label}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="eyebrow" style={{ marginBottom: '6px' }}>settings</div>
        <h2 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 500 }}>
          Control room
        </h2>
        <p className="set-intro">
          Panel preferences - everything here also lives in the Tweaks drawer.
        </p>

        <div className="set-group">
          <div className="set-group-label">Appearance</div>
          <Row label="Layout arrangement" sub="How the dashboard columns are organized">
            <div className="seg">
              {(['cockpit', 'mission', 'modular'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.layout === o ? ' on' : '')}
                  onClick={() => setTweak('layout', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Density" sub="Tighten the rows for a true cockpit feel">
            <div className="seg">
              {(['dense', 'comfy'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.density === o ? ' on' : '')}
                  onClick={() => setTweak('density', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Status accent" sub="Tint for live, focus, and highlights">
            <div className="seg">
              {([['#ffb86c', 'gold'], ['#9e82e8', 'arcane'], ['#6aa8d4', 'celestial']] as const).map(
                ([c, n]) => (
                  <button
                    key={c}
                    className={'seg-b' + (t.accent === c ? ' on' : '')}
                    onClick={() => setTweak('accent', c)}
                  >
                    <span className="swatch" style={{ background: c }} />
                    {n}
                  </button>
                ),
              )}
            </div>
          </Row>
        </div>

        <div className="set-group">
          <div className="set-group-label">Top bar</div>
          <Row label="Clock format">
            <div className="seg">
              {(['12h', '24h'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.clock === o ? ' on' : '')}
                  onClick={() => setTweak('clock', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Starfield behind stats" sub="A faint drift of stars under the gauges">
            <button
              className={'toggle' + (t.starfield ? ' on' : '')}
              onClick={() => setTweak('starfield', !t.starfield)}
            >
              <span className="knob" />
            </button>
          </Row>
        </div>

        <div className="set-group">
          <div className="set-group-label">Twitch connection</div>
          <Row
            label="Twitch login"
            sub={twitchLoginSub}
          >
            {missingTwitchScopes ? (
              <a className="btn-primary" href="/api/auth/twitch?force=1">Reconnect</a>
            ) : status.twitchAuthenticated && status.twitchAuthSource === 'oauth' ? (
              <button className="btn-primary" onClick={onTwitchLogout}>Disconnect</button>
            ) : status.twitchAuthenticated ? (
              <span className="set-badge set-badge--ok">Configured</span>
            ) : (
              <a className="btn-primary" href="/api/auth/twitch">
                Login with Twitch
              </a>
            )}
          </Row>
          <Row
            label="EventSub"
            sub={status.eventSubConnected ? 'Receiving channel events' : 'Not connected - login to enable follows, subs, and alerts'}
          >
            {status.eventSubConnected ? (
              <span className="set-badge set-badge--ok">Connected</span>
            ) : (
              <span className="set-badge">Disconnected</span>
            )}
          </Row>
        </div>

        <p className="set-foot">
          More to come - alerts, hotkeys, OBS scenes.
        </p>
      </div>
    </div>
  );
}
