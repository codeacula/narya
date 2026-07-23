import type { DashboardStatus } from '../../../shared/api';
import { sceneLabel, switchableScenes } from '../../scenes';
import { useMediaMute } from '../../mediaMute';
import { useWindDown } from '../../windDown';

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
  const { muted, busy, toggle } = useMediaMute();

  return (
    <div className="ctrl-section ctrl-mute-section">
      <span className="ctrl-label">commands</span>
      <label className={'ctrl-toggle' + (muted ? ' is-muted' : '')}>
        <input
          type="checkbox"
          checked={muted}
          disabled={busy}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Mute sound/video commands</span>
      </label>
      {muted && (
        <p className="ctrl-inline-warning" role="status">
          Quick-Disable actions are silenced. Redemptions on unflagged actions still play.
        </p>
      )}
    </div>
  );
}

/**
 * The wind-down switch. Signals that the stream is wrapping up — the ending-soon
 * title suffix and the overlay countdown. It does NOT block incoming raids: Twitch
 * exposes no API for that, and a raid during wind-down still celebrates in full.
 */
function WindDownToggle() {
  const { state, busy, toggle } = useWindDown();
  const active = Boolean(state?.active);

  return (
    <div className="ctrl-section ctrl-winddown-section">
      <span className="ctrl-label">wind-down</span>
      <label className={'ctrl-toggle' + (active ? ' is-winding-down' : '')}>
        <input
          type="checkbox"
          checked={active}
          disabled={busy}
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
    </div>
  );
}
