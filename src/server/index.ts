import { registerChattersRoutes } from './chatters';
import { connectTwitchChat } from './chat';
import { registerChatbotCommandRoutes } from './chatbotCommands';
import { config } from './config';
import { registerDashboardRoutes, startDashboardHeartbeat } from './dashboard/status';
import { registerDiscordRoutes } from './discord';
import { connectEventSub, disconnectEventSub, registerEventSubRoutes } from './eventsub';
import { registerGoLiveRoutes } from './goLive';
import { registerLlmRoutes } from './llm';
import { startMusicPolling } from './music';
import { connectObs } from './obs';
import { app, server } from './realtime';
import { registerCoreRoutes } from './routes';
import { RuntimeState } from './runtime';
import { registerStaticRoutes } from './static';
import { hydrateTwitchAuthState, registerTwitchAuthRoutes } from './twitch/auth';
import { registerTwitchApiRoutes } from './twitch/api';

const runtimeState = new RuntimeState();
hydrateTwitchAuthState(runtimeState);

registerCoreRoutes(app, runtimeState);
registerTwitchAuthRoutes({
  app,
  state: runtimeState,
  connectEventSub: () => { void connectEventSub(runtimeState); },
  disconnectEventSub: () => disconnectEventSub(runtimeState),
});
registerTwitchApiRoutes(app, runtimeState);
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
  connectTwitchChat(runtimeState);
  void connectObs();
  startMusicPolling();
  startDashboardHeartbeat(runtimeState);
  void connectEventSub(runtimeState);
});
