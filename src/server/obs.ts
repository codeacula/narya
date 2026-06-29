import OBSWebSocket from 'obs-websocket-js';
import type { ObsStatus } from '../shared/api';
import { appConfig } from './appConfig';
import { broadcast } from './realtime';

const obs = new OBSWebSocket();
const reconnectDelayMs = 5000;

let obsConnectPromise: Promise<void> | null = null;
let reconnectTimer: Timer | null = null;

const obsStatus: ObsStatus = {
  connected: false,
  scenes: appConfig.obsScenes,
  currentProgramScene: null,
  currentPreviewScene: null,
  studioMode: false,
  lastError: null,
  updatedAt: new Date().toISOString(),
};

type SceneListResponse = {
  scenes?: Array<{ sceneName?: string }>;
  currentProgramSceneName?: string;
  currentPreviewSceneName?: string;
};

type StudioModeResponse = {
  studioModeEnabled?: boolean;
};

type SceneNameEvent = {
  sceneName?: string;
};

type SceneListChangedEvent = {
  scenes?: Array<{ sceneName?: string }>;
};

type StudioModeEvent = {
  studioModeEnabled?: boolean;
};

function updateObsStatus(next: Partial<ObsStatus>) {
  Object.assign(obsStatus, next, { updatedAt: new Date().toISOString() });
  broadcast('obs:status', getObsStatus());
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectObs();
  }, reconnectDelayMs);
}

function clearReconnect() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function unavailableObsDashboardStats() {
  return {
    streamActive: null,
    uptimeSeconds: null,
    streamStartedAt: null,
    uptimeSource: null,
    bitrateKbps: null,
    congestion: null,
    totalFrames: null,
    droppedFrames: null,
    laggedFrames: null,
  };
}

export function getObsStatus(): ObsStatus {
  return {
    ...obsStatus,
    scenes: [...obsStatus.scenes],
  };
}

export function isObsConnected(): boolean {
  return obsStatus.connected;
}

export async function refreshObsStatus() {
  const [sceneList, studioMode] = await Promise.all([
    obs.call('GetSceneList') as Promise<SceneListResponse>,
    obs.call('GetStudioModeEnabled') as Promise<StudioModeResponse>,
  ]);
  updateObsStatus({
    connected: true,
    scenes: (sceneList.scenes ?? []).map(scene => scene.sceneName).filter((name): name is string => Boolean(name)),
    currentProgramScene: sceneList.currentProgramSceneName ?? null,
    currentPreviewScene: sceneList.currentPreviewSceneName ?? null,
    studioMode: studioMode.studioModeEnabled ?? false,
    lastError: null,
  });
}

export async function connectObs() {
  if (obsStatus.connected) return;
  if (obsConnectPromise) return obsConnectPromise;

  obsConnectPromise = (async () => {
    try {
      await obs.connect(appConfig.obsUrl, appConfig.obsPassword || undefined);
      clearReconnect();
      await refreshObsStatus();
      console.log(`OBS: connected to ${appConfig.obsUrl}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OBS connection failed';
      updateObsStatus({
        connected: false,
        scenes: appConfig.obsScenes,
        currentProgramScene: null,
        currentPreviewScene: null,
        studioMode: false,
        lastError: message,
      });
      scheduleReconnect();
    } finally {
      obsConnectPromise = null;
    }
  })();

  return obsConnectPromise;
}

export async function reconnectObs() {
  clearReconnect();
  obsConnectPromise = null;
  try {
    await obs.disconnect();
  } catch {
    // Not connected yet — fine, just connect below.
  }
  obsStatus.connected = false;
  await connectObs();
}

async function ensureObs() {
  if (obsStatus.connected) return;
  await connectObs();
  if (!obsStatus.connected) {
    throw new Error(obsStatus.lastError ?? 'OBS is not connected');
  }
}

obs.on('ConnectionClosed', () => {
  updateObsStatus({
    connected: false,
    scenes: appConfig.obsScenes,
    currentProgramScene: null,
    currentPreviewScene: null,
    studioMode: false,
    lastError: 'OBS connection closed',
  });
  obsConnectPromise = null;
  scheduleReconnect();
});

obs.on('CurrentProgramSceneChanged', (event: SceneNameEvent) => {
  updateObsStatus({ currentProgramScene: event.sceneName ?? null, lastError: null });
});

obs.on('CurrentPreviewSceneChanged', (event: SceneNameEvent) => {
  updateObsStatus({ currentPreviewScene: event.sceneName ?? null, lastError: null });
});

obs.on('SceneListChanged', (event: SceneListChangedEvent) => {
  updateObsStatus({
    scenes: (event.scenes ?? []).map(scene => scene.sceneName).filter((name): name is string => Boolean(name)),
    lastError: null,
  });
  void refreshObsStatus().catch((error: unknown) => {
    console.error('OBS: failed to refresh scene list:', error);
  });
});

obs.on('StudioModeStateChanged', (event: StudioModeEvent) => {
  updateObsStatus({ studioMode: event.studioModeEnabled ?? false, lastError: null });
  void refreshObsStatus().catch((error: unknown) => {
    console.error('OBS: failed to refresh studio mode state:', error);
  });
});

export async function switchObsScene(sceneName: string): Promise<ObsStatus> {
  await ensureObs();
  if (obsStatus.scenes.length > 0 && !obsStatus.scenes.includes(sceneName)) {
    throw new Error(`OBS scene "${sceneName}" was not found`);
  }
  await obs.call('SetCurrentProgramScene', { sceneName });
  updateObsStatus({ currentProgramScene: sceneName, lastError: null });
  return getObsStatus();
}

export async function triggerObsTransition(): Promise<ObsStatus> {
  await ensureObs();
  await obs.call('TriggerStudioModeTransition');
  await refreshObsStatus();
  return getObsStatus();
}

export async function startObsStream(): Promise<ObsStatus> {
  await ensureObs();
  const streamStatus = await obs.call('GetStreamStatus') as { outputActive?: boolean };
  if (!streamStatus.outputActive) {
    await obs.call('StartStream');
  }
  await refreshObsStatus();
  return getObsStatus();
}

export async function getObsDashboardStats() {
  type ObsStreamStatus = {
    outputActive?: boolean;
    outputTimecode?: string;
    outputDuration?: number;
    outputBytes?: number;
    outputCongestion?: number;
    outputSkippedFrames?: number;
    outputTotalFrames?: number;
  };
  type ObsStats = {
    renderSkippedFrames?: number;
    renderTotalFrames?: number;
    activeFps?: number;
  };

  const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OBS request timed out')), ms);
      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };

  try {
    if (!obsStatus.connected) {
      await withTimeout(connectObs(), 1200).catch(() => undefined);
    }

    if (!obsStatus.connected) {
      return unavailableObsDashboardStats();
    }

    const [streamStatus, stats] = await Promise.all([
      withTimeout(obs.call('GetStreamStatus') as Promise<ObsStreamStatus>, 1200),
      withTimeout(obs.call('GetStats') as Promise<ObsStats>, 1200),
    ]);
    const parseTimecode = (tc: string): number | null => {
      const [hms] = tc.split('.');
      const parts = hms.split(':').map(Number);
      if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
      const [h, m, s] = parts;
      return (h * 3600) + (m * 60) + s;
    };
    const uptimeSeconds = streamStatus.outputActive && streamStatus.outputTimecode
      ? parseTimecode(streamStatus.outputTimecode)
      : null;

    const durationMs = streamStatus.outputDuration ?? 0;
    const totalFrames = streamStatus.outputTotalFrames ?? null;
    const droppedFrames = streamStatus.outputSkippedFrames ?? null;
    const laggedFrames = stats.renderSkippedFrames ?? null;
    const bitrateKbps = typeof streamStatus.outputBytes === 'number' && streamStatus.outputActive && durationMs > 0
      ? Math.round((streamStatus.outputBytes * 8) / (durationMs / 1000) / 1000)
      : null;
    const congestion = streamStatus.outputCongestion ?? null;

    return {
      streamActive: streamStatus.outputActive ?? null,
      uptimeSeconds,
      streamStartedAt: null,
      uptimeSource: uptimeSeconds !== null ? 'obs' as const : null,
      bitrateKbps,
      congestion,
      totalFrames,
      droppedFrames,
      laggedFrames,
    };
  } catch (error) {
    updateObsStatus({
      lastError: error instanceof Error ? error.message : 'OBS dashboard stats unavailable',
    });
    return unavailableObsDashboardStats();
  }
}
