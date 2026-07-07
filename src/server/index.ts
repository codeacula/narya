import { registerAppConfigRoutes, type AppConfigChange } from './appConfig';
import { requireDashboardToken } from './auth';
import { startAutomaticAds } from './automaticAds';
import { registerChattersRoutes } from './chatters';
import { applyTwitchChannel, connectTwitchChat } from './chat';
import { registerChatbotCommandRoutes } from './chatbotCommands';
import { config } from './config';
import { registerDashboardRoutes, startDashboardHeartbeat } from './dashboard/status';
import { clearDiscordStatusCache, registerDiscordRoutes } from './discord';
import { connectEventSub, disconnectEventSub, registerEventSubRoutes } from './eventsub';
import { registerGoLiveRoutes } from './goLive';
import { registerLlmRoutes } from './llm';
import { restartMusicPolling, startMusicPolling } from './music';
import { connectObs, reconnectObs } from './obs';
import { app, broadcast, server } from './realtime';
import { registerCoreRoutes } from './routes';
import { RuntimeState } from './runtime';
import { registerStaticRoutes } from './static';
import { registerStreamCategoryRoutes } from './streamCategories';
import { hydrateTwitchAuthState, registerTwitchAuthRoutes } from './twitch/auth';
import { registerTwitchApiRoutes } from './twitch/api';
import { registerViewerRewardRoutes } from './viewerRewards';

const runtimeState = new RuntimeState();
hydrateTwitchAuthState(runtimeState);

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
  if (changes.has('music')) {
    restartMusicPolling();
  }
  if (changes.has('discord')) {
    clearDiscordStatusCache();
  }
}

// Guard every /api/* route with the shared token (no-op when unset).
app.use('/api', requireDashboardToken);

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
registerStreamCategoryRoutes(app);
registerChatbotCommandRoutes(app);
registerLlmRoutes(app);
registerDiscordRoutes(app);
registerGoLiveRoutes(app);
registerChattersRoutes(app, runtimeState);
registerEventSubRoutes(app, runtimeState);
registerDashboardRoutes(app, runtimeState);
registerStaticRoutes(app);

server.listen(config.port, () => {
  console.log(`Streamer Tools backend listening on http://localhost:${config.port}`);
  if (!config.dashboardToken) {
    console.warn('⚠️  DASHBOARD_TOKEN is not set — the API and WebSocket are unauthenticated. Set it in .env to require a token.');
  }
  connectTwitchChat(runtimeState);
  void connectObs();
  startMusicPolling();
  startDashboardHeartbeat(runtimeState);
  startAutomaticAds(runtimeState);
  void connectEventSub(runtimeState);
});
