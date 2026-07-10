import React from 'react';
import type { ObsStatus } from '../../shared/api';
import { AutomodQuickActions } from '../automod';
import { useSocket } from '../realtime';
import { useSoundButtons } from '../sounds';
import { sceneLabel, switchableScenes } from '../scenes';
import {
  getObsStatus,
  playSoundButton,
  switchObsScene,
  triggerObsTransition,
} from '../services/dashboard';

const emptyObsStatus: ObsStatus = {
  connected: false,
  scenes: [],
  currentProgramScene: null,
  currentPreviewScene: null,
  studioMode: false,
  lastError: null,
  updatedAt: new Date(0).toISOString(),
};

function useObsStatus() {
  const [obsStatus, setObsStatus] = React.useState<ObsStatus>(emptyObsStatus);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    getObsStatus()
      .then((status) => {
        setObsStatus(status);
        setError(null);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Failed to load OBS status');
      });
  }, []);

  useSocket<ObsStatus>(
    'obs:status',
    React.useCallback((nextStatus) => {
      setObsStatus(nextStatus);
      setError(null);
    }, []),
  );

  return { obsStatus, setObsStatus, error };
}

export function TabletPage() {
  const { obsStatus, setObsStatus, error: statusError } = useObsStatus();
  const soundButtons = useSoundButtons();
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [commandError, setCommandError] = React.useState<string | null>(null);

  const scenes = switchableScenes(obsStatus.scenes);
  const currentProgram = obsStatus.currentProgramScene;
  // The gold scene button already marks the live scene, so the Program readout is
  // only worth showing when the current program has no button (a non-switchable
  // scene, or nothing selected yet).
  const programOffList = currentProgram === null || !scenes.includes(currentProgram);
  const obsUnavailable = !obsStatus.connected;
  const hasScenes = scenes.length > 0;
  const controlsDisabled = obsUnavailable || Boolean(pendingAction);
  const connectionClass = obsStatus.connected ? 'tabletStatusDot connected' : 'tabletStatusDot disconnected';

  async function runObsCommand(action: string, command: () => Promise<{ obsStatus?: ObsStatus }>) {
    setPendingAction(action);
    setCommandError(null);
    try {
      const result = await command();
      if (result.obsStatus) setObsStatus(result.obsStatus);
    } catch (caught: unknown) {
      setCommandError(caught instanceof Error ? caught.message : 'OBS command failed');
    } finally {
      setPendingAction(null);
    }
  }

  function playSound(id: string) {
    void playSoundButton(id).catch((caught: unknown) => {
      setCommandError(caught instanceof Error ? caught.message : `Failed to play sound ${id}`);
    });
  }

  return (
    <main className="tabletShell">
      <header>
        <div>
          <p className="eyebrow">Tablet Panel</p>
          <h1>Stream Controls</h1>
        </div>
        <a className="tabletBackLink" href="/">Dashboard</a>
      </header>

      <div className="tabletControlGrid">
        <section className="tabletPanel obsPanel">
          <div className="tabletPanelHeader">
            <div>
              <p className="eyebrow">OBS</p>
              <h2>Scene Control</h2>
            </div>
            <span className="tabletStatus">
              <span className={connectionClass} />
              {obsStatus.connected ? 'Connected' : 'Unavailable'}
            </span>
          </div>

          <div className="obsSceneSummary">
            {programOffList ? (
              <div>
                <span>Program</span>
                <b>{currentProgram ?? 'None'}</b>
              </div>
            ) : null}
            {obsStatus.studioMode ? (
              <div>
                <span>Preview</span>
                <b>{obsStatus.currentPreviewScene ?? 'None'}</b>
              </div>
            ) : null}
            <div>
              <span>Studio Mode</span>
              <b>{obsStatus.studioMode ? 'On' : 'Off'}</b>
            </div>
          </div>

          {statusError || obsStatus.lastError || commandError ? (
            <p className="tabletError">{commandError ?? statusError ?? obsStatus.lastError}</p>
          ) : null}

          <div className="tabletButtonGrid sceneGrid">
            {hasScenes ? scenes.map(scene => {
              const isCurrent = scene === obsStatus.currentProgramScene;
              const className = isCurrent ? 'sceneButton current' : 'sceneButton';
              const isPending = pendingAction === `scene:${scene}`;
              return (
                <button
                  className={className}
                  disabled={controlsDisabled || isCurrent}
                  key={scene}
                  onClick={() => {
                    void runObsCommand(`scene:${scene}`, () => switchObsScene(scene));
                  }}
                >
                  <span>{sceneLabel(scene)}</span>
                  {isPending ? <small>Switching</small> : null}
                </button>
              );
            }) : (
              <p className="muted">No OBS scenes available yet.</p>
            )}
          </div>

          {obsStatus.studioMode ? (
            <button
              className="transitionButton"
              disabled={controlsDisabled}
              onClick={() => {
                void runObsCommand('transition', triggerObsTransition);
              }}
            >
              <span>Transition</span>
              <small>{pendingAction === 'transition' ? 'Running' : 'Take preview live'}</small>
            </button>
          ) : null}
        </section>

        <div className="tabletSideStack">
        <section className="tabletPanel">
          <div className="tabletPanelHeader">
            <div>
              <p className="eyebrow">Audio</p>
              <h2>Sounds</h2>
            </div>
          </div>
          <div className="tabletButtonGrid">
            {soundButtons.length > 0 ? soundButtons.map(sound => (
              <button key={sound.id} onClick={() => playSound(sound.id)}>
                {sound.label}
              </button>
            )) : <p className="muted">No sound buttons configured.</p>}
          </div>
        </section>

        <section className="tabletPanel">
          <div className="tabletPanelHeader">
            <div>
              <p className="eyebrow">Moderation</p>
              <h2>AutoMod Queue</h2>
            </div>
          </div>
          <AutomodQuickActions />
        </section>
        </div>
      </div>
    </main>
  );
}
