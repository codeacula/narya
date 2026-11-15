import React from 'react';
import type { HoldingScene, ObsStatus } from '../../shared/api';
import { AutomodQuickActions } from '../automod';
import { TabletChatPanel } from '../tabletChat';
import { TabletQuickActions } from '../quickActions';
import { useClipButtons } from '../clips';
import { useCountdown } from '../countdown';
import { endsAtFor, useHoldingSceneControls } from '../holdingScenes';
import { pinnedCardSummary, usePinnedCardControls } from '../pinnedCard';
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
import { obsNotice } from '../obsNotice';
import { EmptyState } from '../ui/emptyState';

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
  // Until the first status lands, `emptyObsStatus` says "disconnected" — which is a
  // placeholder, not a fact, and must not be reported as OBS being down.
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    getObsStatus()
      .then((status) => {
        setObsStatus(status);
        setLoaded(true);
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
      setLoaded(true);
      setError(null);
    }, []),
  );

  return { obsStatus, setObsStatus, loaded, error };
}

const HOLDING_PRESETS = [5, 10, 15] as const;
const HOLDING_SCENES: { scene: HoldingScene; label: string }[] = [
  { scene: 'starting', label: 'Starting soon' },
  { scene: 'brb', label: 'Be right back' },
];

function HoldingReadout({ endsAt }: { endsAt: string | null }) {
  const reading = useCountdown(endsAt);
  return <span className="holding-readout">{reading ? reading.label : 'no countdown'}</span>;
}

/**
 * Set or clear the Starting soon and Be right back countdowns from the tablet. Fine
 * adjustment and the Ending scene's "next stream" line stay on the dashboard.
 */
function TabletHoldingScenes({ onError }: { onError: (message: string) => void }) {
  const { state, busy, start, clear } = useHoldingSceneControls(onError);
  return (
    <section className="tablet-panel holding-panel">
      <div className="tablet-panel-header">
        <div>
          <p className="eyebrow">Scenes</p>
          <h2>Countdowns</h2>
        </div>
      </div>
      {HOLDING_SCENES.map(({ scene, label }) => {
        const endsAt = endsAtFor(state, scene);
        return (
          <div className="media-group" key={scene}>
            <p className="media-group-label">{label} <HoldingReadout endsAt={endsAt} /></p>
            <div className="tablet-button-grid">
              {HOLDING_PRESETS.map(minutes => (
                <button
                  key={minutes}
                  disabled={busy}
                  onClick={event => { blurIfPointer(event); void start(scene, minutes); }}
                >
                  {minutes} min
                </button>
              ))}
              <button
                disabled={busy || endsAt === null}
                onClick={event => { blurIfPointer(event); void clear(scene); }}
              >
                Clear
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * What the pinned card shows and a clear button. Pinning a question is a button on a
 * chat row (the chat panel is on this surface too); topic entry stays on the dashboard.
 */
function TabletPinnedCard({ onError }: { onError: (message: string) => void }) {
  const { card, busy, clear } = usePinnedCardControls(onError);
  return (
    <section className="tablet-panel pinned-panel">
      <div className="tablet-panel-header">
        <div>
          <p className="eyebrow">On stream</p>
          <h2>Pinned card</h2>
        </div>
      </div>
      <p className="media-group-label">{pinnedCardSummary(card)}</p>
      <div className="tablet-button-grid">
        <button
          disabled={busy || card === null}
          onClick={event => { blurIfPointer(event); void clear(); }}
        >
          Clear
        </button>
      </div>
    </section>
  );
}

export function TabletPage() {
  const { obsStatus, setObsStatus, loaded: obsLoaded, error: statusError } = useObsStatus();
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
  const notice = obsNotice({ obsStatus, loaded: obsLoaded, statusError, commandError });

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
                  {obsStatus.connected ? 'Connected' : 'Offline'}
                </span>
                {/* Studio mode is something OBS reports. While OBS is unreachable the
                    server zeroes it, so "Studio off" would be a claim nobody made. */}
                {obsStatus.connected ? (
                  <span className="tablet-status">
                    <span className={'tablet-status-dot ' + (obsStatus.studioMode ? 'connected' : 'idle')} />
                    Studio {obsStatus.studioMode ? 'On' : 'Off'}
                  </span>
                ) : null}
              </div>
            </div>

            {/* Same reasoning for the Program readout: "None" while offline is not
                what is on stream, it is only what this page does not know. */}
            {obsStatus.connected && (programOffList || obsStatus.studioMode) ? (
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

            {notice ? (
              <div
                className={'tablet-error' + (notice.tone === 'offline' ? ' tablet-error--offline' : '')}
                role="status"
                title={notice.detail ?? undefined}
              >
                <p>{notice.message}</p>
                {notice.detail ? <p className="tablet-error-detail">{notice.detail}</p> : null}
              </div>
            ) : null}

            {/* While OBS is offline the notice above already says the buttons come
                back on reconnect, so an empty grid says nothing more. A connected OBS
                with no scenes is the only case left to explain. */}
            {hasScenes ? (
              <div className="tablet-button-grid sceneGrid">
                {scenes.map(scene => {
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
                })}
              </div>
            ) : obsStatus.connected ? (
              <EmptyState size="compact" title="No scenes">OBS reports no scenes to switch between.</EmptyState>
            ) : null}

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

          <TabletHoldingScenes onError={setCommandError} />

          <TabletPinnedCard onError={setCommandError} />

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
                )) : (
                  <EmptyState size="compact" title="No sounds yet">Add sound buttons in Settings → Content.</EmptyState>
                )}
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
                )) : (
                  <EmptyState size="compact" title="No clips yet">Add clip buttons in Settings → Content.</EmptyState>
                )}
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
