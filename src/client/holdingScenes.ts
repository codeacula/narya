import React from 'react';
import type { HoldingScene, HoldingScenesState } from '../shared/api';
import { errorMessage } from './errors';
import { useLiveValue } from './liveValue';
import {
  adjustHoldingCountdown,
  getHoldingScenes,
  saveNextStream,
  setHoldingCountdown,
} from './services/dashboard';

const EMPTY: HoldingScenesState = { startingEndsAt: null, brbEndsAt: null, nextStream: '' };

/** REST seed + live `overlay:holding-scenes`; shared by the scenes and the operator controls. */
export function useHoldingScenes(): [HoldingScenesState, React.Dispatch<React.SetStateAction<HoldingScenesState>>] {
  return useLiveValue<HoldingScenesState>(getHoldingScenes, 'overlay:holding-scenes', EMPTY);
}

export function endsAtFor(state: HoldingScenesState, scene: HoldingScene): string | null {
  return scene === 'starting' ? state.startingEndsAt : state.brbEndsAt;
}

/**
 * The operator's side: the live state plus writes that report a failure through
 * `onError` instead of throwing. Each write's response is also applied locally, so a
 * missed socket event cannot leave the controls showing a stale clock.
 */
export function useHoldingSceneControls(onError: (message: string) => void) {
  const [state, setState] = useHoldingScenes();
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback((write: () => Promise<HoldingScenesState>, fallback: string) => {
    setBusy(true);
    return write()
      .then((next) => { setState(next); return true; })
      .catch((caught: unknown) => { onError(errorMessage(caught, fallback)); return false; })
      .finally(() => setBusy(false));
  }, [onError, setState]);

  return {
    state,
    busy,
    start: (scene: HoldingScene, minutes: number) => run(() => setHoldingCountdown(scene, minutes), 'Could not set the countdown'),
    clear: (scene: HoldingScene) => run(() => setHoldingCountdown(scene, null), 'Could not clear the countdown'),
    adjust: (scene: HoldingScene, deltaMinutes: number) => run(() => adjustHoldingCountdown(scene, deltaMinutes), 'Could not adjust the countdown'),
    saveNext: (text: string) => run(() => saveNextStream(text), 'Could not save the next-stream text'),
  };
}
