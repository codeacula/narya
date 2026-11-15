import React from 'react';
import type { DashboardStatus, HoldingScene } from '../../../shared/api';
import { useCountdown } from '../../countdown';
import { endsAtFor, useHoldingSceneControls } from '../../holdingScenes';
import { pinnedCardSummary, usePinnedCardControls } from '../../pinnedCard';
import { useToast } from '../notifications';
import { sceneLabel, switchableScenes } from '../../scenes';
import { useMediaMute } from '../../mediaMute';
import { useWindDown } from '../../windDown';
import { useDirtyGuard } from '../dirtyGuard';
import { SettingsAnnouncer } from '../../pages/settings/shared';

export function ControlsPanel({
  status,
  scenes,
  scenePrefix,
  currentScene,
  onSwitchScene,
  sceneSwitching,
}: {
  status: DashboardStatus;
  scenes: string[];
  scenePrefix: string;
  currentScene: string | null;
  onSwitchScene: (sceneName: string) => void;
  sceneSwitching: boolean;
}) {
  const sceneOptions = switchableScenes(scenes, scenePrefix);
  // Lay scenes out in exactly two balanced rows so the buttons line up evenly
  // instead of wrapping raggedly into a single tall row.
  const sceneColumns = Math.max(1, Math.ceil(sceneOptions.length / 2));
  return (
    <div className="ctrl-panel">
      {status.obsConnected && sceneOptions.length > 0 && (
        <div className="ctrl-section ctrl-scene-section">
          <span className="ctrl-label">scene</span>
          <div
            className="ctrl-scene-grid"
            style={{ gridTemplateColumns: `repeat(${sceneColumns}, minmax(0, 1fr))` }}
            role="group"
            aria-label="Switch OBS scene"
          >
            {sceneOptions.map(sceneName => {
              const isActive = currentScene === sceneName;
              return (
                <button
                  className={`ctrl-scene-button${isActive ? ' active' : ''}`}
                  type="button"
                  aria-pressed={isActive}
                  disabled={sceneSwitching || isActive}
                  key={sceneName}
                  onClick={() => onSwitchScene(sceneName)}
                >
                  {sceneLabel(sceneName, scenePrefix)}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* The overlay-bounds switch used to live here. It moved to the nav bar's
          Display panel: this panel only mounts when OBS is connected, so the control
          for positioning OBS sources disappeared exactly when OBS was down. The mute
          toggle stays — it is persisted operator state, not a positioning aid. */}
      <MediaMuteToggle />
      <WindDownToggle />
      <HoldingScenesControls />
      <PinnedCardControls />
    </div>
  );
}

/**
 * The master "mute sound/video commands" switch. While engaged, the server skips
 * every Action flagged Quick Disable — spammed sound/video commands go quiet at
 * once, while unflagged redemptions keep working. Persisted, so a restart keeps it
 * lit until the operator turns it off.
 */
function MediaMuteToggle() {
  const { muted, status, retry, busy, error, toggle } = useMediaMute();
  // Until the server has said, the box is not drawn ticked or unticked as if it knew.
  const known = status === 'loaded';

  return (
    <div className="ctrl-section ctrl-mute-section">
      <span className="ctrl-label">commands</span>
      <label className={'ctrl-toggle' + (known && muted ? ' is-muted' : '')}>
        <input
          type="checkbox"
          checked={known && muted}
          disabled={busy || !known}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Mute sound/video commands</span>
      </label>
      {known && muted && (
        <p className="ctrl-inline-warning" role="status">
          Quick-Disable actions are silenced. Redemptions on unflagged actions still play.
        </p>
      )}
      <ControlProblem
        unreadable={status === 'failed' ? 'Could not read whether commands are muted.' : null}
        error={error}
        onRetry={retry}
      />
    </div>
  );
}

/**
 * What went wrong with a persisted switch: its state could not be read (with a Retry,
 * since nothing else re-asks until the socket reconnects), or a flip was refused. The
 * spoken half is always mounted (`SettingsAnnouncer`) so the line is announced.
 */
function ControlProblem({
  unreadable,
  error,
  onRetry,
}: {
  unreadable: string | null;
  error: string | null;
  onRetry: () => void;
}) {
  const text = error ?? unreadable;
  return (
    <>
      <SettingsAnnouncer error={text} />
      {text ? (
        <p className="ctrl-inline-warning ctrl-inline-problem">
          <span aria-hidden="true">{text}</span>
          {!error && unreadable ? (
            <button className="stale-notice-retry" type="button" onClick={onRetry}>Retry</button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

/**
 * The wind-down switch. Signals that the stream is wrapping up — the ending-soon
 * title suffix and the overlay countdown. It does NOT block incoming raids: Twitch
 * exposes no API for that, and a raid during wind-down still celebrates in full.
 */
function WindDownToggle() {
  const { state, status, retry, busy, error, toggle } = useWindDown();
  const known = status === 'loaded';
  const active = known && Boolean(state?.active);

  return (
    <div className="ctrl-section ctrl-winddown-section">
      <span className="ctrl-label">wind-down</span>
      <label className={'ctrl-toggle' + (active ? ' is-winding-down' : '')}>
        <input
          type="checkbox"
          checked={active}
          disabled={busy || !known}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Signal ending soon</span>
      </label>
      {active && (
        <p className="ctrl-inline-warning" role="status">
          {state?.source === 'scheduled' ? 'Started automatically. ' : ''}
          Title suffix and countdown overlay are live. Raids still land and still celebrate.
        </p>
      )}
      <ControlProblem
        unreadable={status === 'failed' ? 'Could not read whether the wind-down is on.' : null}
        error={error}
        onRetry={retry}
      />
    </div>
  );
}

const HOLDING_PRESETS = [5, 10, 15] as const;
const HOLDING_NUDGE_MINUTES = 5;
const HOLDING_SCENES: { scene: HoldingScene; label: string }[] = [
  { scene: 'starting', label: 'starting' },
  { scene: 'brb', label: 'brb' },
];

/** One scene's clock readout: ticking, negative once overdue, a dash when none is set. */
function HoldingReadout({ endsAt }: { endsAt: string | null }) {
  const reading = useCountdown(endsAt);
  const overdue = reading !== null && reading.msRemaining < 0;
  return (
    <span className={'ctrl-holding-readout' + (overdue ? ' is-overdue' : '')} aria-live="off">
      {reading ? reading.label : '—'}
    </span>
  );
}

/**
 * Countdowns for the Starting soon and Be right back scenes, plus the Ending scene's
 * "next stream" line. A countdown never stops on its own: past zero it runs negative
 * on stream, so the operator sees the same "-02:15" the viewers do and can nudge it.
 */
function HoldingScenesControls() {
  const { pushToast } = useToast();
  const onError = React.useCallback(
    (message: string) => pushToast({ kind: 'error', title: 'Holding scenes', message }),
    [pushToast],
  );
  const controls = useHoldingSceneControls(onError);
  const { state, busy } = controls;
  const [nextDraft, setNextDraft] = React.useState<string | null>(null);
  const nextValue = nextDraft ?? state.nextStream;
  useDirtyGuard(nextDraft !== null && nextDraft !== state.nextStream, 'the next-stream line');

  return (
    <div className="ctrl-section ctrl-holding-section">
      {HOLDING_SCENES.map(({ scene, label }) => {
        const endsAt = endsAtFor(state, scene);
        const isSet = endsAt !== null;
        return (
          <div className="ctrl-holding-row" key={scene} role="group" aria-label={`${label} countdown`}>
            <span className="ctrl-label">{label}</span>
            <HoldingReadout endsAt={endsAt} />
            <div className="ctrl-holding-buttons">
              {HOLDING_PRESETS.map(minutes => (
                <button
                  className="ctrl-scene-button"
                  type="button"
                  disabled={busy}
                  key={minutes}
                  onClick={() => { void controls.start(scene, minutes); }}
                >
                  {minutes}m
                </button>
              ))}
              <button
                className="ctrl-scene-button"
                type="button"
                disabled={busy || !isSet}
                aria-label={`Subtract ${HOLDING_NUDGE_MINUTES} minutes from ${label}`}
                onClick={() => { void controls.adjust(scene, -HOLDING_NUDGE_MINUTES); }}
              >
                −{HOLDING_NUDGE_MINUTES}
              </button>
              <button
                className="ctrl-scene-button"
                type="button"
                disabled={busy || !isSet}
                aria-label={`Add ${HOLDING_NUDGE_MINUTES} minutes to ${label}`}
                onClick={() => { void controls.adjust(scene, HOLDING_NUDGE_MINUTES); }}
              >
                +{HOLDING_NUDGE_MINUTES}
              </button>
              <button
                className="ctrl-scene-button"
                type="button"
                disabled={busy || !isSet}
                onClick={() => { void controls.clear(scene); }}
              >
                clear
              </button>
            </div>
          </div>
        );
      })}
      <form
        className="ctrl-holding-row"
        onSubmit={event => {
          event.preventDefault();
          void controls.saveNext(nextValue).then(saved => { if (saved) setNextDraft(null); });
        }}
      >
        <label className="ctrl-label" htmlFor="holding-next-stream">next</label>
        <input
          id="holding-next-stream"
          className="ctrl-holding-input"
          type="text"
          maxLength={140}
          placeholder="Next stream: day and time"
          value={nextValue}
          onChange={event => setNextDraft(event.target.value)}
        />
        <button
          className="ctrl-scene-button"
          type="submit"
          disabled={busy || nextValue.trim() === state.nextStream}
        >
          save
        </button>
      </form>
    </div>
  );
}

/** Matches the server's cap, so the field stops where the card would truncate. */
const PINNED_TOPIC_MAX = 200;

/**
 * The card on stream: what it shows now, a field for the operator's own topic, and
 * clear. Pinning a viewer's question is a button on the chat row, not here — the
 * server reads the message itself, so there is nothing to type for that.
 */
function PinnedCardControls() {
  const { pushToast } = useToast();
  const onError = React.useCallback(
    (message: string) => pushToast({ kind: 'error', title: 'Pinned card', message }),
    [pushToast],
  );
  const { card, busy, pinTopic, clear } = usePinnedCardControls(onError);
  const [draft, setDraft] = React.useState('');
  useDirtyGuard(draft.trim() !== '', 'the pinned topic');

  return (
    <div className="ctrl-section ctrl-pinned-section">
      <p className={'ctrl-pinned-readout' + (card ? '' : ' is-empty')} title={pinnedCardSummary(card)} aria-live="polite">
        {pinnedCardSummary(card)}
      </p>
      <form
        className="ctrl-holding-row"
        onSubmit={event => {
          event.preventDefault();
          void pinTopic(draft).then(pinned => { if (pinned) setDraft(''); });
        }}
      >
        <label className="ctrl-label" htmlFor="pinned-topic">pinned</label>
        <input
          id="pinned-topic"
          className="ctrl-holding-input"
          type="text"
          maxLength={PINNED_TOPIC_MAX}
          placeholder="A topic to put on stream"
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <button className="ctrl-scene-button" type="submit" disabled={busy || draft.trim() === ''}>
          pin topic
        </button>
        <button className="ctrl-scene-button" type="button" disabled={busy || card === null} onClick={() => { void clear(); }}>
          clear
        </button>
      </form>
    </div>
  );
}
