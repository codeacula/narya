import React from 'react';
import type { WindDownSettings } from '../../../shared/api';
import { getWindDownSettings, saveWindDownSettings } from '../../services/dashboard';
import { SettingsStatus, useSettingsForm } from './shared';

const EMPTY_WIND_DOWN_SETTINGS: WindDownSettings = {
  leadMinutes: 15,
  titleSuffix: '| Ending soon',
  titleEnabled: true,
  overlayEnabled: true,
  updatedAt: null,
};

export function WindDownSection() {
  const windDownForm = useSettingsForm<WindDownSettings>({
    initial: EMPTY_WIND_DOWN_SETTINGS,
    load: () => getWindDownSettings(),
    loadError: 'Could not load wind-down settings',
    save: settings => saveWindDownSettings({
      leadMinutes: settings.leadMinutes,
      titleSuffix: settings.titleSuffix,
      titleEnabled: settings.titleEnabled,
      overlayEnabled: settings.overlayEnabled,
    }),
    saveError: 'Could not save wind-down settings',
  });
  const windDownSettings = windDownForm.value;
  const setWindDownSettings = windDownForm.setValue;
  const { loading: windDownLoading, saving: windDownSaving, message: windDownMessage, error: windDownError } = windDownForm;

  const handleWindDownSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    windDownForm.submit(windDownSettings, 'Wind-down settings saved');
  };

  return (
    <div className="set-group">
      <div className="set-group-label">Wind-down schedule</div>

      <form className="command-settings-form" onSubmit={handleWindDownSubmit}>
        <label className="field">
          <span>Lead time (minutes)</span>
          <input
            type="number"
            min="0"
            max="720"
            value={windDownSettings.leadMinutes}
            disabled={windDownLoading || windDownSaving}
            onChange={event => setWindDownSettings(current => ({ ...current, leadMinutes: Number(event.target.value) }))}
          />
          <small>Minutes before your planned end time to start signalling. 0 turns the schedule off.</small>
        </label>

        <label className="field">
          <span>Title suffix</span>
          <input
            value={windDownSettings.titleSuffix}
            disabled={windDownLoading || windDownSaving}
            maxLength={60}
            placeholder="| Ending soon"
            onChange={event => setWindDownSettings(current => ({ ...current, titleSuffix: event.target.value }))}
          />
          <small>{windDownSettings.titleSuffix.length}/60 · appended to your Twitch title while winding down, and removed once it ends.</small>
        </label>

        <label className="command-enabled">
          <input
            type="checkbox"
            checked={windDownSettings.titleEnabled}
            disabled={windDownLoading || windDownSaving}
            onChange={event => setWindDownSettings(current => ({ ...current, titleEnabled: event.target.checked }))}
          />
          <span>Update the Twitch title</span>
        </label>

        <label className="command-enabled">
          <input
            type="checkbox"
            checked={windDownSettings.overlayEnabled}
            disabled={windDownLoading || windDownSaving}
            onChange={event => setWindDownSettings(current => ({ ...current, overlayEnabled: event.target.checked }))}
          />
          <span>Show the countdown overlay</span>
        </label>

        <SettingsStatus message={windDownMessage} error={windDownError} />

        <div className="command-settings-actions">
          <button className="modbtn gold" type="submit" disabled={windDownLoading || windDownSaving}>
            {windDownSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
