import { registerActionRoutes } from './actions';
import { registerAppConfigRoutes, type AppConfigChange } from './appConfig';
import { getOverlayToken, requireDashboardToken } from './auth';
import { getActionExecutor, getTriggerDispatcher, initAutomation } from './automation';
import { registerAutomationTriggerRoutes, seedBuiltInSlashCommands } from './automationTriggers';
import { startAutomaticAds } from './automaticAds';
import { registerCategoryModuleRoutes, reconcileCategoryModules } from './categoryModules';
import { registerChattersRoutes } from './chatters';
import {
  migrateLegacyAlerts,
  migrateLegacyCategoryModules,
  migrateLegacyChatbotCommands,
  migrateLegacyMediaIntoAssets,
  migrateLegacyRewardBindings,
  migrateQuackCommandIntoAction,
} from './legacyMigration';
import { registerMediaAssetRoutes } from './mediaAssets';
import { registerMediaMuteRoutes } from './mediaMute';
import { registerOverlayPlaceholderRoutes } from './overlayPlaceholders';
import { applyTwitchChannel, connectTwitchChat } from './chat';
import { config, isLoopbackHost } from './config';
import { registerDashboardRoutes, startDashboardHeartbeat } from './dashboard/status';
import { clearDiscordStatusCache, registerDiscordRoutes } from './discord';
import { connectEventSub, disconnectEventSub, registerEventSubRoutes } from './eventsub';
import { registerGoLiveRoutes } from './goLive';
import { registerLlmRoutes } from './llm';
import { restartMusicPolling, startMusicPolling } from './music';
import { broadcastObsStatus, connectObs, reconnectObs } from './obs';
import { app, broadcast, server } from './realtime';
import { registerCoreRoutes } from './routes';
import { RuntimeState } from './runtime';
import { registerStaticRoutes } from './static';
import { registerStreamCategoryRoutes } from './streamCategories';
import { registerStreamStatusRoutes } from './streamStatus';
import { pruneAutomationRuns } from './triggerDispatcher';
import { hydrateTwitchAuthState, registerTwitchAuthRoutes } from './twitch/auth';
import { registerTwitchApiRoutes } from './twitch/api';
import { registerViewerRewardRoutes } from './viewerRewards';
import { registerViewerRoleRoutes } from './viewers';

const runtimeState = new RuntimeState();
hydrateTwitchAuthState(runtimeState);
// Convert the pre-automation tables before anything serves a request, so the
// first read of /api/media-assets already reflects the operator's existing media.
// Guarded by the migration ledger; a second boot is a no-op.
// Order matters: the chatbot migration binds sound steps to media-asset ids, which
// only exist once the media migration has run.
migrateLegacyMediaIntoAssets();
migrateLegacyChatbotCommands();
migrateLegacyRewardBindings();
migrateLegacyAlerts();
migrateLegacyCategoryModules();
// Same reason: !quack was a hard-coded chat branch, and is now an ordinary Action
// with a random-selection play_media step. Must follow the media migration, which
// is what gives the quack sounds the asset ids this binds to.
migrateQuackCommandIntoAction();
initAutomation(runtimeState);
// The four commands the dashboard chat bar used to parse client-side, seeded as
// ordinary editable Action + trigger rows rather than special-cased code paths.
seedBuiltInSlashCommands();

// Apply a settings change by reconnecting only the services whose config changed,
// so the operator never has to restart the process after editing Settings.
function reconcileServices(changes: Set<AppConfigChange>) {
  if (changes.has('twitchChannel')) {
    runtimeState.clearTwitchChannelState();
    void applyTwitchChannel();
  }
  if (changes.has('twitchChannel') || changes.has('twitchCredentials')) {
    runtimeState.twitchAppToken = null;
    disconnectEventSub(runtimeState);
    void connectEventSub(runtimeState);
  }
  if (changes.has('obs')) {
    void reconnectObs();
  }
  // Display-only: the dashboard and tablet read the prefix off obs:status, so they
  // just need to be told. Reconnecting OBS to apply it would drop a live session.
  if (changes.has('obsScenePrefix')) {
    broadcastObsStatus();
  }
  if (changes.has('music')) {
    restartMusicPolling();
  }
  if (changes.has('discord')) {
    clearDiscordStatusCache();
  }
}

// Auth is fail-closed on anything reachable off-box: an unauthenticated API here
// can ban viewers, drive OBS, rewrite Twitch rewards, and replace credentials, so
// serving it beyond loopback without a token is refused rather than warned about.
if (!config.dashboardToken && !isLoopbackHost(config.host)) {
  console.error(
    `Refusing to start: HOST=${config.host} exposes the API beyond loopback but DASHBOARD_TOKEN is not set.\n` +
    'Set DASHBOARD_TOKEN in .env (any long random string, e.g. `openssl rand -hex 32`), or drop HOST to bind loopback only.',
  );
  process.exit(1);
}

// Guard every /api/* route: operator token = full control, overlay token = the
// read-only allowlist in auth.ts. Unauthenticated only on a loopback-bound server.
app.use('/api', requireDashboardToken);

// The URL an OBS browser source should use. Operator-only (the middleware above
// blocks overlay tokens from reaching it), so an overlay can't read it back.
app.get('/api/auth/overlay-token', (_request, response) => {
  response.json({ token: getOverlayToken() });
});

registerCoreRoutes(app, runtimeState);
registerAppConfigRoutes(app, ({ config: nextConfig, changes }) => {
  reconcileServices(changes);
  broadcast('settings:updated', { updatedAt: nextConfig.updatedAt ?? new Date().toISOString() });
});
registerTwitchAuthRoutes({
  app,
  state: runtimeState,
  connectEventSub: () => { void connectEventSub(runtimeState); },
  disconnectEventSub: () => disconnectEventSub(runtimeState),
});
registerTwitchApiRoutes(app, runtimeState);
registerViewerRewardRoutes(app, runtimeState);
registerMediaAssetRoutes(app);
registerActionRoutes(app, getActionExecutor());
registerAutomationTriggerRoutes(app, getTriggerDispatcher());
registerCategoryModuleRoutes(app, runtimeState);
registerStreamCategoryRoutes(app);
registerStreamStatusRoutes(app);
registerOverlayPlaceholderRoutes(app);
registerMediaMuteRoutes(app);
registerLlmRoutes(app);
registerDiscordRoutes(app);
registerGoLiveRoutes(app);
registerChattersRoutes(app, runtimeState);
registerViewerRoleRoutes(app, runtimeState);
registerEventSubRoutes(app, runtimeState);
registerDashboardRoutes(app, runtimeState);
registerStaticRoutes(app);

server.listen(config.port, config.host, () => {
  console.log(`Streamer Tools backend listening on http://${config.host}:${config.port}`);
  if (!config.dashboardToken) {
    console.log('Auth is disabled (no DASHBOARD_TOKEN); the server is bound to loopback only.');
  }
  connectTwitchChat(runtimeState);
  void connectObs();
  startMusicPolling();
  startDashboardHeartbeat(runtimeState);
  startAutomaticAds(runtimeState);
  void connectEventSub(runtimeState);

  // automation_runs is both the invocation log and the dedupe table, so it grows
  // with every trigger that fires. Prune on boot and daily thereafter; the window
  // is well clear of the longest cooldown and any EventSub redelivery gap.
  const pruned = pruneAutomationRuns();
  if (pruned > 0) console.log(`Automation: pruned ${pruned} expired run record(s).`);
  setInterval(() => {
    try {
      pruneAutomationRuns();
    } catch (error) {
      console.error('Automation: could not prune run records:', error);
    }
  }, 24 * 60 * 60 * 1000).unref();
});
