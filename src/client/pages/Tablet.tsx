import React from 'react';
import type { ObsStatus } from '../../shared/api';
import { AutomodQuickActions } from '../automod';
import { TabletChatPanel } from '../tabletChat';
import { TabletQuickActions } from '../quickActions';
import { useClipButtons } from '../clips';
import { useMediaMute } from '../mediaMute';
import { useSocket } from '../realtime';
import { useSoundButtons } from '../sounds';
import { sceneLabel, switchableScenes } from '../scenes';
import {
  getObsStatus,
  playClipButton,
  playSoundButton,
  switchObsScene,
  triggerObsTransition,
} from '../services/dashboard';
import { errorMessage } from '../errors';

// Dropping focus after a tap keeps a tablet's on-screen button from staying
// visually "stuck" highlighted. Keyboard activation (Enter/Space) also fires
// onClick but reports an empty pointerType and detail 0 — leave that focus in
// place so keyboard navigation isn't disrupted.
function blurIfPointer(event: React.MouseEvent<HTMLButtonElement>): void {
  const { pointerType } = event.nativeEvent as PointerEvent;
  if (pointerType || event.detail > 0) event.currentTarget.blur();
}

const emptyObsStatus: ObsStatus = {
  connected: false,
  scenes: [],
  scenePrefix: '',
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
        setError(errorMessage(caught, 'Failed to load OBS status'));
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
  const clipButtons = useClipButtons();
  const media = useMediaMute();
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [commandError, setCommandError] = React.useState<string | null>(null);

  const scenes = switchableScenes(obsStatus.scenes, obsStatus.scenePrefix);
  const currentProgram = obsStatus.currentProgramScene;
  // The gold scene button already marks the live scene, so the Program readout is
  // only worth showing when the current program has no button (a non-switchable
  // scene, or nothing selected yet).
  const programOffList = currentProgram === null || !scenes.includes(currentProgram);
  const obsUnavailable = !obsStatus.connected;
  const hasScenes = scenes.length > 0;
  const controlsDisabled = obsUnavailable || Boolean(pendingAction);
  const connectionClass = obsStatus.connected ? 'tablet-status-dot connected' : 'tablet-status-dot disconnected';

  async function runObsCommand(action: string, command: () => Promise<{ obsStatus?: ObsStatus }>) {
    setPendingAction(action);
    setCommandError(null);
    try {
      const result = await command();
      if (result.obsStatus) setObsStatus(result.obsStatus);
    } catch (caught: unknown) {
      setCommandError(errorMessage(caught, 'OBS command failed'));
    } finally {
      setPendingAction(null);
    }
  }

  function playSound(id: string) {
    void playSoundButton(id).catch((caught: unknown) => {
      setCommandError(errorMessage(caught, `Failed to play sound ${id}`));
    });
  }

  function playClip(id: string) {
    void playClipButton(id).catch((caught: unknown) => {
      setCommandError(errorMessage(caught, `Failed to play clip ${id}`));
    });
  }

  return (
    <main className="tablet-shell">
      <header>
        <div>
          <p className="eyebrow">Tablet Panel</p>
          <h1>Stream Controls</h1>
        </div>
        <a className="tablet-back-link" href="/">Dashboard</a>
      </header>

      <div className="tablet-control-grid">
        <div className="tablet-column">
          <section className="tablet-panel obsPanel">
            <div className="tablet-panel-header">
              <div>
                <p className="eyebrow">OBS</p>
                <h2>Scene Control</h2>
              </div>
              <div className="tablet-status-group">
                <span className="tablet-status">
                  <span className={connectionClass} />
                  {obsStatus.connected ? 'Connected' : 'Unavailable'}
                </span>
                <span className="tablet-status">
                  <span className={'tablet-status-dot ' + (obsStatus.studioMode ? 'connected' : 'idle')} />
                  Studio {obsStatus.studioMode ? 'On' : 'Off'}
                </span>
              </div>
            </div>

            {programOffList || obsStatus.studioMode ? (
              <div className="obs-scene-summary">
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
              </div>
            ) : null}

            {statusError || obsStatus.lastError || commandError ? (
              <p className="tablet-error">{commandError ?? statusError ?? obsStatus.lastError}</p>
            ) : null}

            <div className="tablet-button-grid sceneGrid">
              {hasScenes ? scenes.map(scene => {
                const isCurrent = scene === obsStatus.currentProgramScene;
                const className = isCurrent ? 'scene-button current' : 'scene-button';
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
                    <span>{sceneLabel(scene, obsStatus.scenePrefix)}</span>
                    {isPending ? <small>Switching</small> : null}
                  </button>
                );
              }) : (
                <p className="muted">No OBS scenes available yet.</p>
              )}
            </div>

            {obsStatus.studioMode ? (
              <button
                className="transition-button"
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

          <TabletQuickActions />

          <section className="tablet-panel media-panel">
            <div className="tablet-panel-header">
              <div>
                <p className="eyebrow">Soundboard</p>
                <h2>Media</h2>
              </div>
              <button
                type="button"
                className={'tablet-mute-button' + (media.muted ? ' active' : '')}
                aria-pressed={media.muted}
                disabled={media.busy}
                onClick={event => { blurIfPointer(event); media.toggle(!media.muted); }}
              >
                {media.muted ? '🔇 Commands muted' : '🔊 Mute commands'}
              </button>
            </div>

            <div className="media-group">
              <p className="media-group-label">Sounds</p>
              <div className="tablet-button-grid">
                {soundButtons.length > 0 ? soundButtons.map(sound => (
                  <button
                    key={sound.id}
                    onClick={event => { blurIfPointer(event); playSound(sound.id); }}
                  >
                    {sound.label}
                  </button>
                )) : <p className="muted">No sounds yet — add them in Settings → Content.</p>}
              </div>
            </div>

            <div className="media-group">
              <p className="media-group-label">Clips</p>
              <div className="tablet-button-grid">
                {clipButtons.length > 0 ? clipButtons.map(clip => (
                  <button
                    key={clip.id}
                    onClick={event => { blurIfPointer(event); playClip(clip.id); }}
                  >
                    {clip.label}
                  </button>
                )) : <p className="muted">No clips yet — add them in Settings → Content.</p>}
              </div>
            </div>
          </section>
        </div>

        <div className="tablet-column">
          <section className="tablet-panel automod-panel">
            <div className="tablet-panel-header">
              <div>
                <p className="eyebrow">Moderation</p>
                <h2>AutoMod Queue</h2>
              </div>
            </div>
            <AutomodQuickActions />
          </section>

          <TabletChatPanel />
        </div>
      </div>
    </main>
  );
}
