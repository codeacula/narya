import React from 'react';
import type { DashboardStatus } from '../../../shared/api';
import type { SettingsRoute } from '../../routing';
import { SETTINGS_GROUPS, sectionsInGroup } from './sections';
import { SettingsHeader } from './shared';
import { ConnectionsSettingsPage } from '../SettingsPage';
import { GoLiveSection } from './GoLiveSection';
import { ContentSection } from './ContentSection';
import { TtsSection } from './TtsSection';
import { LlmSection } from './LlmSection';
import { ActionsSettingsPage } from './ActionsPage';
import { AutomationSettingsPage } from './AutomationPage';
import { ModulesSettingsPage } from './ModulesPage';
import { CountersPage } from './CountersPage';
import { ViewerRewardsPage } from '../ViewerRewardsPage';
import { StreamCategoriesPage } from '../StreamCategoriesPage';

/**
 * The left rail. Sections hang off a single hairline meridian; the active one lights its
 * node gold and the meridian glows through it. A node can also carry a warning dot, which
 * is the one piece of live state the rail shows — see `needsAttention` below.
 */
function SettingsRail({
  active,
  onNavigate,
  attention,
}: {
  active: SettingsRoute;
  onNavigate: (route: SettingsRoute) => void;
  attention: Partial<Record<SettingsRoute, string>>;
}) {
  return (
    <nav className="settings-rail" aria-label="Settings sections">
      <div className="rail-head">
        <div className="rail-eyebrow">settings</div>
        <div className="rail-title">Control room</div>
      </div>
      <div className="rail-meridian">
        {SETTINGS_GROUPS.map(group => (
          <div className="rail-group" key={group.id}>
            <h2 className="rail-group-label">{group.label}</h2>
            <ul className="rail-list">
              {sectionsInGroup(group.id).map(section => {
                const warning = attention[section.id];
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      className={'rail-item' + (active === section.id ? ' active' : '') + (warning ? ' warn' : '')}
                      aria-current={active === section.id ? 'page' : undefined}
                      onClick={() => onNavigate(section.id)}
                    >
                      <span className="rail-node" aria-hidden="true" />
                      <span className="rail-label">{section.label}</span>
                      {warning ? <span className="rail-warn" title={warning} aria-label={warning} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function SettingsBody({
  route,
  status,
  onTwitchLogout,
  onTwitchBotLogout,
}: {
  route: SettingsRoute;
  status: DashboardStatus;
  onTwitchLogout: () => void;
  onTwitchBotLogout: () => void;
}) {
  switch (route) {
    case 'settings':
      return (
        <ConnectionsSettingsPage
          status={status}
          onTwitchLogout={onTwitchLogout}
          onTwitchBotLogout={onTwitchBotLogout}
        />
      );
    case 'golive':
      return <><SettingsHeader section="golive" /><GoLiveSection /></>;
    case 'categories':
      return <StreamCategoriesPage />;
    case 'rewards':
      return <ViewerRewardsPage />;
    case 'actions':
      return <ActionsSettingsPage />;
    case 'automation':
      return <AutomationSettingsPage />;
    case 'modules':
      return <ModulesSettingsPage />;
    case 'counters':
      return <CountersPage />;
    case 'content':
      return <><SettingsHeader section="content" /><ContentSection /></>;
    case 'speech':
      return <><SettingsHeader section="speech" /><TtsSection /></>;
    case 'ai':
      return <><SettingsHeader section="ai" /><LlmSection /></>;
  }
}

export function SettingsShell({
  route,
  status,
  onNavigate,
  onTwitchLogout,
  onTwitchBotLogout,
}: {
  route: SettingsRoute;
  status: DashboardStatus;
  onNavigate: (route: SettingsRoute) => void;
  onTwitchLogout: () => void;
  onTwitchBotLogout: () => void;
}) {
  // Twitch auth is the one settings failure the operator can be looking away from: every
  // other section is inert until it works. Flag it on the rail from wherever they are.
  const attention: Partial<Record<SettingsRoute, string>> = {};
  if (!status.twitchAuthenticated) {
    attention.settings = 'Twitch is not connected';
  } else if (status.twitchMissingScopes.length > 0) {
    attention.settings = `Twitch is missing scopes: ${status.twitchMissingScopes.join(', ')}`;
  } else if (!status.eventSubConnected) {
    attention.settings = 'EventSub is not connected';
  } else if (status.eventSubFailedSubscriptions.length > 0) {
    attention.settings = `These events are not arriving: ${status.eventSubFailedSubscriptions.join(', ')}`;
  }

  return (
    <div className="settings-shell">
      <SettingsRail active={route} onNavigate={onNavigate} attention={attention} />
      <div className="settings-canvas">
        {/* Keyed by route so switching sections replays the rise-in, and so a section
            never inherits the scroll-restored state of the one before it. */}
        <div className="settings-measure" key={route}>
          <SettingsBody
            route={route}
            status={status}
            onTwitchLogout={onTwitchLogout}
            onTwitchBotLogout={onTwitchBotLogout}
          />
        </div>
      </div>
    </div>
  );
}
