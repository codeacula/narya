import OBSWebSocket from 'obs-websocket-js';
import { config } from './config';

const obs = new OBSWebSocket();
let obsConnected = false;

export function isObsConnected(): boolean {
  return obsConnected;
}

async function ensureObs() {
  if (obsConnected) return;

  try {
    await obs.connect(config.obsUrl, config.obsPassword || undefined);
    obsConnected = true;
  } catch (error) {
    obsConnected = false;
    throw error;
  }
}

obs.on('ConnectionClosed', () => {
  obsConnected = false;
});

export async function switchObsScene(sceneName: string) {
  await ensureObs();
  await obs.call('SetCurrentProgramScene', { sceneName });
}

export async function triggerObsTransition() {
  await ensureObs();
  await obs.call('TriggerStudioModeTransition');
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
    await withTimeout(ensureObs(), 1200);
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
  } catch {
    obsConnected = false;
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
}
