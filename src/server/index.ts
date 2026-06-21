import { connectTwitchChat } from './chat';
import { config } from './config';
import { registerDashboardRoutes, startDashboardHeartbeat } from './dashboard/status';
import { connectEventSub, disconnectEventSub } from './eventsub';
import { startMusicPolling } from './music';
import { connectObs } from './obs';
import { app, server } from './realtime';
import { registerCoreRoutes } from './routes';
import { RuntimeState } from './runtime';
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
registerDashboardRoutes(app, runtimeState);

server.listen(config.port, () => {
  console.log(`Streamer Tools backend listening on http://localhost:${config.port}`);
  connectTwitchChat();
  void connectObs().catch((error: unknown) => {
    console.error('OBS: initial connection failed:', error);
  });
  startMusicPolling();
  startDashboardHeartbeat(runtimeState);
  void connectEventSub(runtimeState);
});
