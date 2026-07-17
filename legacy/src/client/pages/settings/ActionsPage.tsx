import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Action,
  ActionRunResult,
  ActionStepInput,
  ActionStepType,
  ActionUpsert,
  ChatSender,
  MediaAsset,
  MediaSelection,
  TextStyle,
} from '../../../shared/api';
import {
  createAction,
  deleteAction,
  getActions,
  getMediaAssets,
  getObsStatus,
  runAction,
  updateAction,
} from '../../services/dashboard';
import { SettingsHeader } from './shared';
import {
  MAX_ASSETS_PER_STEP,
  MAX_STEPS,
  STEP_TYPES,
  STEP_TYPE_LABELS,
  actionToUpsert,
  formatDelay,
  moveStep,
  newStep,
  removeStep,
  runResultTone,
  summarizeRunResult,
  unplayableAssetIds,
  validateAction,
} from './automation';

const EMPTY_DRAFT: ActionUpsert = { name: '', description: '', enabled: true, quickDisable: false, steps: [] };

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

/** The tokens a template may interpolate. Absent ones render empty, never as literals. */
const TEMPLATE_HINT = 'Tokens: {actor} {login} {message} {input} {rewardTitle} {amount} {tier} {months} {category} {module}';

// --- Per-type payload editors -------------------------------------------------

function AssetPicker({
  assetIds,
  assets,
  disabled,
  onChange,
}: {
  assetIds: string[];
  assets: MediaAsset[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) => {
    if (assetIds.includes(id)) {
      onChange(assetIds.filter(entry => entry !== id));
      return;
    }
    if (assetIds.length >= MAX_ASSETS_PER_STEP) return;
    onChange([...assetIds, id]);
  };

  // A referenced asset that no longer exists still has to be visible, or the
  // operator cannot tell why the step is flagged — let alone remove the reference.
  const orphans = assetIds.filter(id => !assets.some(asset => asset.id === id));

  return (
    <div className="action-asset-picker">
      {assets.length === 0 && orphans.length === 0 ? (
        <div className="command-empty">
          No media assets configured. Add them in Settings → Content → Media library.
        </div>
      ) : (
        <>
          {assets.map(asset => {
            const broken = !asset.enabled || !asset.available;
            return (
              <label className={'action-asset-option' + (broken ? ' action-asset-option--broken' : '')} key={asset.id}>
                <input
                  type="checkbox"
                  checked={assetIds.includes(asset.id)}
                  disabled={disabled}
                  onChange={() => toggle(asset.id)}
                />
                <span className="action-asset-label">{asset.label}</span>
                <span className="media-asset-tag">{asset.kind}</span>
                {!asset.enabled && <span className="media-asset-tag media-asset-tag--off">disabled</span>}
                {!asset.available && <span className="media-asset-tag media-asset-tag--broken">file missing</span>}
              </label>
            );
          })}
          {orphans.map(id => (
            <label className="action-asset-option action-asset-option--broken" key={id}>
              <input type="checkbox" checked disabled={disabled} onChange={() => toggle(id)} />
              <span className="action-asset-label">{id}</span>
              <span className="media-asset-tag media-asset-tag--broken">deleted asset</span>
            </label>
          ))}
        </>
      )}
    </div>
  );
}

function StepPayloadFields({
  step,
  assets,
  scenes,
  disabled,
  onChange,
}: {
  step: ActionStepInput;
  assets: MediaAsset[];
  scenes: string[];
  disabled: boolean;
  onChange: (next: ActionStepInput) => void;
}) {
  switch (step.type) {
    case 'show_text':
      return (
        <>
          <label className="field settings-wide-field">
            <span>Text</span>
            <input
              value={step.payload.template}
              disabled={disabled}
              maxLength={500}
              placeholder="{actor} just raided with {amount} viewers!"
              onChange={event => onChange({ ...step, payload: { ...step.payload, template: event.target.value } })}
            />
            <small className="action-hint">{TEMPLATE_HINT}</small>
          </label>
          <label className="field">
            <span>Style</span>
            <select
              value={step.payload.style}
              disabled={disabled}
              onChange={event => onChange({ ...step, payload: { ...step.payload, style: event.target.value as TextStyle } })}
            >
              <option value="banner">Banner</option>
              <option value="toast">Toast</option>
              <option value="centered">Centered</option>
            </select>
          </label>
          <label className="field">
            <span>On screen for (seconds)</span>
            <input
              type="number"
              min={1}
              max={60}
              step={0.5}
              value={step.payload.durationMs / 1000}
              disabled={disabled}
              onChange={event => onChange({
                ...step,
                payload: { ...step.payload, durationMs: Math.round(Number(event.target.value) * 1000) },
              })}
            />
          </label>
        </>
      );

    case 'play_media':
      return (
        <>
          <div className="field settings-wide-field">
            <span>Media assets</span>
            <AssetPicker
              assetIds={step.payload.assetIds}
              assets={assets}
              disabled={disabled}
              onChange={assetIds => onChange({ ...step, payload: { ...step.payload, assetIds } })}
            />
            <small className="action-hint">
              Assets come from the configured catalog, never a raw file path. A disabled or missing asset never plays.
            </small>
          </div>
          <label className="field">
            <span>When several are picked</span>
            <select
              value={step.payload.selection}
              disabled={disabled}
              onChange={event => onChange({
                ...step,
                payload: { ...step.payload, selection: event.target.value as MediaSelection },
              })}
            >
              <option value="first">Play the first playable one</option>
              <option value="random">Play a random one</option>
            </select>
          </label>
          <label className="field">
            <span>Volume override</span>
            <select
              value={step.payload.volume === undefined ? 'asset' : 'custom'}
              disabled={disabled}
              onChange={event => onChange({
                ...step,
                payload: event.target.value === 'asset'
                  ? { assetIds: step.payload.assetIds, selection: step.payload.selection }
                  : { ...step.payload, volume: 0.8 },
              })}
            >
              <option value="asset">Use each asset's own volume</option>
              <option value="custom">Override</option>
            </select>
            {step.payload.volume !== undefined && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={step.payload.volume}
                disabled={disabled}
                onChange={event => onChange({
                  ...step,
                  payload: { ...step.payload, volume: Number(event.target.value) },
                })}
              />
            )}
          </label>
        </>
      );

    case 'tts_speak':
    case 'llm_response':
      return (
        <label className="field settings-wide-field">
          <span>{step.type === 'tts_speak' ? 'Say' : 'Prompt'}</span>
          <input
            value={step.payload.template}
            disabled={disabled}
            maxLength={500}
            placeholder={step.type === 'tts_speak' ? '{actor} says {input}' : 'Answer {actor} in one sentence: {input}'}
            onChange={event => onChange({ ...step, payload: { ...step.payload, template: event.target.value } })}
          />
          <small className="action-hint">{TEMPLATE_HINT}</small>
        </label>
      );

    case 'send_chat':
      return (
        <>
          <label className="field settings-wide-field">
            <span>Message</span>
            <input
              value={step.payload.template}
              disabled={disabled}
              maxLength={500}
              placeholder="Thanks for the raid, {actor}!"
              onChange={event => onChange({ ...step, payload: { ...step.payload, template: event.target.value } })}
            />
            <small className="action-hint">{TEMPLATE_HINT}</small>
          </label>
          <label className="field">
            <span>Send as</span>
            <select
              value={step.payload.sender}
              disabled={disabled}
              onChange={event => onChange({ ...step, payload: { ...step.payload, sender: event.target.value as ChatSender } })}
            >
              <option value="bot">Bot account</option>
              <option value="user">Broadcaster account</option>
            </select>
          </label>
        </>
      );

    case 'obs_scene':
      return (
        <label className="field settings-wide-field">
          <span>Scene</span>
          <input
            value={step.payload.sceneName}
            disabled={disabled}
            maxLength={160}
            list="action-obs-scenes"
            placeholder="Starting soon"
            onChange={event => onChange({ ...step, payload: { sceneName: event.target.value } })}
          />
          <datalist id="action-obs-scenes">
            {scenes.map(scene => <option key={scene} value={scene} />)}
          </datalist>
          <small className="action-hint">
            {scenes.length > 0 ? 'Scenes read from the connected OBS.' : 'OBS is not connected — the name is saved as typed.'}
          </small>
        </label>
      );

    case 'obs_transition':
      return (
        <div className="field settings-wide-field">
          <small className="action-hint">Triggers the studio-mode transition. Nothing to configure.</small>
        </div>
      );

    case 'twitch_shoutout':
      return (
        <label className="field settings-wide-field">
          <span>Shout out</span>
          <input
            value={step.payload.loginTemplate}
            disabled={disabled}
            maxLength={500}
            placeholder="{login}"
            onChange={event => onChange({ ...step, payload: { loginTemplate: event.target.value } })}
          />
          <small className="action-hint">A Twitch login, or a token like {'{login}'} for whoever triggered this.</small>
        </label>
      );

    case 'twitch_whisper':
      return (
        <>
          <label className="field">
            <span>Whisper to</span>
            <input
              value={step.payload.loginTemplate}
              disabled={disabled}
              maxLength={500}
              placeholder="{login}"
              onChange={event => onChange({ ...step, payload: { ...step.payload, loginTemplate: event.target.value } })}
            />
          </label>
          <label className="field settings-wide-field">
            <span>Message</span>
            <input
              value={step.payload.template}
              disabled={disabled}
              maxLength={500}
              onChange={event => onChange({ ...step, payload: { ...step.payload, template: event.target.value } })}
            />
            <small className="action-hint">{TEMPLATE_HINT}</small>
          </label>
        </>
      );

    case 'twitch_timeout':
      return (
        <>
          <label className="field">
            <span>Time out</span>
            <input
              value={step.payload.loginTemplate}
              disabled={disabled}
              maxLength={500}
              placeholder="{login}"
              onChange={event => onChange({ ...step, payload: { ...step.payload, loginTemplate: event.target.value } })}
            />
          </label>
          <label className="field">
            <span>Seconds</span>
            <input
              type="text"
              value={step.payload.secondsTemplate}
              disabled={disabled}
              placeholder="600 or {arg2}"
              onChange={event => onChange({
                ...step,
                payload: { ...step.payload, secondsTemplate: event.target.value },
              })}
            />
            {/* Text, not number: the duration may be bound from the invocation
                ("/timeout bob 300 spam" → {arg2}) rather than fixed on the Action. */}
          </label>
          <label className="field">
            <span>Reason (optional)</span>
            <input
              value={step.payload.reasonTemplate}
              disabled={disabled}
              maxLength={500}
              onChange={event => onChange({ ...step, payload: { ...step.payload, reasonTemplate: event.target.value } })}
            />
          </label>
        </>
      );

    case 'twitch_ban':
      return (
        <>
          <label className="field">
            <span>Ban</span>
            <input
              value={step.payload.loginTemplate}
              disabled={disabled}
              maxLength={500}
              placeholder="{login}"
              onChange={event => onChange({ ...step, payload: { ...step.payload, loginTemplate: event.target.value } })}
            />
          </label>
          <label className="field settings-wide-field">
            <span>Reason (optional)</span>
            <input
              value={step.payload.reasonTemplate}
              disabled={disabled}
              maxLength={500}
              onChange={event => onChange({ ...step, payload: { ...step.payload, reasonTemplate: event.target.value } })}
            />
          </label>
        </>
      );
  }
}

// --- Step row -----------------------------------------------------------------

function StepRow({
  step,
  index,
  total,
  assets,
  scenes,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  step: ActionStepInput;
  index: number;
  total: number;
  assets: MediaAsset[];
  scenes: string[];
  disabled: boolean;
  onChange: (next: ActionStepInput) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const broken = unplayableAssetIds(step, assets);

  return (
    <div className={'action-step' + (step.enabled ? '' : ' action-step--off')}>
      <div className="action-step-head">
        <span className="action-step-index">{index + 1}</span>

        <select
          className="action-step-type"
          value={step.type}
          disabled={disabled}
          // Switching type replaces the payload wholesale: the old one is not a
          // valid payload for the new type, so carrying it over would be unsound.
          onChange={event => onChange({
            ...newStep(event.target.value as ActionStepType),
            enabled: step.enabled,
            delayMs: step.delayMs,
          })}
        >
          {STEP_TYPES.map(type => (
            <option key={type} value={type}>{STEP_TYPE_LABELS[type]}</option>
          ))}
        </select>

        <label className="action-step-delay field">
          <span>Delay (s)</span>
          <input
            type="number"
            min={0}
            max={600}
            step={0.5}
            value={step.delayMs / 1000}
            disabled={disabled}
            onChange={event => onChange({ ...step, delayMs: Math.round(Number(event.target.value) * 1000) })}
          />
        </label>

        <label className="command-enabled">
          <input
            type="checkbox"
            checked={step.enabled}
            disabled={disabled}
            onChange={event => onChange({ ...step, enabled: event.target.checked })}
          />
          <span>On</span>
        </label>

        <div className="command-row-actions">
          <button
            className="modbtn"
            type="button"
            title="Move up"
            disabled={disabled || index === 0}
            onClick={() => onMove(index - 1)}
          >
            ↑
          </button>
          <button
            className="modbtn"
            type="button"
            title="Move down"
            disabled={disabled || index === total - 1}
            onClick={() => onMove(index + 1)}
          >
            ↓
          </button>
          <button className="modbtn danger" type="button" disabled={disabled} onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      <div className="action-step-body">
        <StepPayloadFields step={step} assets={assets} scenes={scenes} disabled={disabled} onChange={onChange} />
      </div>

      <div className="action-step-foot">
        <span className="action-step-timing">Starts {formatDelay(step.delayMs)} after the action begins.</span>
        {broken.length > 0 && (
          <span className="media-asset-tag media-asset-tag--broken">
            {broken.length} asset{broken.length === 1 ? '' : 's'} will not play
          </span>
        )}
      </div>
    </div>
  );
}

// --- Run result ---------------------------------------------------------------

function RunResult({ result }: { result: ActionRunResult }) {
  const tone = runResultTone(result);
  const failures = result.steps.filter(step => step.status !== 'succeeded');

  return (
    <div className={`action-run-result action-run-result--${tone}`}>
      <div className="action-run-head">
        <span className={`action-run-status action-run-status--${tone}`}>{result.status}</span>
        <span>{summarizeRunResult(result)}</span>
      </div>
      {failures.length > 0 && (
        <ul className="action-run-steps">
          {failures.map(step => (
            <li key={step.stepId}>
              <span className={`action-run-step-status action-run-step-status--${step.status}`}>{step.status}</span>
              <b>{STEP_TYPE_LABELS[step.type]}</b>
              <span>{step.detail || 'No detail given.'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Page ---------------------------------------------------------------------

export function ActionsSettingsPage() {
  const [actions, setActions] = useState<Action[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [scenes, setScenes] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ActionUpsert | null>(null);
  const [runs, setRuns] = useState<Record<string, ActionRunResult>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextActions, nextAssets] = await Promise.all([getActions(), getMediaAssets()]);
    setActions(nextActions);
    setAssets(nextAssets);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorText(caught, 'Could not load actions')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // OBS may be down; a scene list is a convenience, not a requirement.
  useEffect(() => {
    void getObsStatus()
      .then(status => setScenes(status.scenes))
      .catch(() => setScenes([]));
  }, []);

  const busy = loading || saving;
  const problem = useMemo(() => (draft ? validateAction(draft) : null), [draft]);

  const startCreate = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT, steps: [newStep('show_text')] });
    setMessage(null);
    setError(null);
  };

  const startEdit = (action: Action) => {
    setEditingId(action.id);
    setDraft(actionToUpsert(action));
    setMessage(null);
    setError(null);
  };

  const closeEditor = () => {
    setEditingId(null);
    setDraft(null);
  };

  const handleSave = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || problem) return;
    setSaving(true);
    setMessage(null);
    setError(null);

    const request = editingId ? updateAction(editingId, draft) : createAction(draft);
    void request
      .then(async saved => {
        await load();
        // Stay on the saved action so a follow-up Run targets what was just written.
        setEditingId(saved.id);
        setDraft(actionToUpsert(saved));
        setMessage('Action saved');
      })
      .catch(caught => setError(errorText(caught, 'Could not save the action')))
      .finally(() => setSaving(false));
  };

  const handleDelete = (action: Action) => {
    if (!window.confirm(`Delete "${action.name}"? Triggers that reference it will stop firing.`)) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    void deleteAction(action.id)
      .then(() => load())
      .then(() => {
        if (editingId === action.id) closeEditor();
        setMessage('Action deleted');
      })
      .catch(caught => setError(errorText(caught, 'Could not delete the action')))
      .finally(() => setSaving(false));
  };

  const handleRun = (action: Action) => {
    setBusyId(action.id);
    setMessage(null);
    setError(null);
    void runAction(action.id)
      .then(result => setRuns(current => ({ ...current, [action.id]: result })))
      .catch(caught => setError(errorText(caught, 'Could not run the action')))
      .finally(() => setBusyId(null));
  };

  const updateStep = (index: number, next: ActionStepInput) => {
    setDraft(current => (current
      ? { ...current, steps: current.steps.map((step, i) => (i === index ? next : step)) }
      : current));
  };

  return (
    <>
        <SettingsHeader section="actions" />

        {(message || error) && (
          <div className={'command-settings-status' + (error ? ' error' : '')}>{error ?? message}</div>
        )}

        <div className="set-group">
          <div className="set-group-label">Actions</div>

          <div className="settings-split">
            <div className="settings-split-list">
              <div className="split-list-head">
                <div className="set-sub">Pick an action to edit, run, or delete it.</div>
                <button className="modbtn gold" type="button" disabled={busy} onClick={startCreate}>New</button>
              </div>

              <div className="settings-mini-list">
                {loading ? (
                  <div className="command-empty">Loading actions...</div>
                ) : actions.length === 0 ? (
                  <div className="command-empty">No actions yet. Create one, then point a trigger at it.</div>
                ) : actions.map(action => (
                  <button
                    type="button"
                    key={action.id}
                    className={'settings-item-row' + (editingId === action.id ? ' is-selected' : '')}
                    aria-current={editingId === action.id ? 'true' : undefined}
                    onClick={() => startEdit(action)}
                  >
                    <div className="settings-item-main">
                      <b>{action.name}</b>
                      <span>
                        {action.steps.length} step{action.steps.length === 1 ? '' : 's'}
                        {action.steps.length > 0 && ` · ${action.steps.map(step => STEP_TYPE_LABELS[step.type]).join(' → ')}`}
                      </span>
                      <div className="media-asset-tags">
                        {!action.enabled && <span className="media-asset-tag media-asset-tag--off">disabled</span>}
                        {action.quickDisable && <span className="media-asset-tag">quick-disable</span>}
                        {action.description && <span className="media-asset-tag">{action.description}</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-split-detail">
              {!draft ? (
                <div className="split-empty">
                  <div className="es-orb" />
                  <div className="es-title">Nothing selected</div>
                  <div className="es-sub">
                    Pick an action on the left to edit its steps, run it as a test, or delete it. New
                    builds one from scratch.
                  </div>
                </div>
              ) : (
            <form className="settings-editor-section" onSubmit={handleSave}>
              <div className="command-editor-head">
                <div>
                  <div className="set-label">{draft.name || 'Untitled action'}</div>
                  <div className="set-sub">Steps run in order. A step that fails does not stop the ones after it.</div>
                </div>
                <div className="command-row-actions">
                  {/* Run and Delete act on what is *saved*, so they only exist once the
                      action does — a draft has nothing on the server to fire or remove. */}
                  {editingId && (
                    <button
                      className="modbtn gold"
                      type="button"
                      disabled={busy || busyId === editingId}
                      onClick={() => { const action = actions.find(a => a.id === editingId); if (action) handleRun(action); }}
                    >
                      {busyId === editingId ? 'Running...' : 'Run'}
                    </button>
                  )}
                  {editingId && (
                    <button
                      className="modbtn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => { const action = actions.find(a => a.id === editingId); if (action) handleDelete(action); }}
                    >
                      Delete
                    </button>
                  )}
                  <button className="modbtn" type="button" disabled={saving} onClick={closeEditor}>Close</button>
                </div>
              </div>

              {editingId && runs[editingId] && <RunResult result={runs[editingId]} />}

              <div className="settings-mini-form">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={draft.name}
                    disabled={busy}
                    maxLength={120}
                    placeholder="Raid hype"
                    onChange={event => setDraft(current => (current ? { ...current, name: event.target.value } : current))}
                  />
                </label>
                <label className="field">
                  <span>Description</span>
                  <input
                    value={draft.description}
                    disabled={busy}
                    maxLength={500}
                    placeholder="Plays the horn and thanks the raider"
                    onChange={event => setDraft(current => (current ? { ...current, description: event.target.value } : current))}
                  />
                </label>
                <label className="command-enabled">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={busy}
                    onChange={event => setDraft(current => (current ? { ...current, enabled: event.target.checked } : current))}
                  />
                  <span>Enabled</span>
                </label>
                <label className="command-enabled">
                  <input
                    type="checkbox"
                    checked={draft.quickDisable}
                    disabled={busy}
                    onChange={event => setDraft(current => (current ? { ...current, quickDisable: event.target.checked } : current))}
                  />
                  <span>Quick Disable</span>
                </label>
                <small className="action-hint">
                  Quick Disable lets the "Mute sound/video commands" button in Stream Controls silence this action.
                </small>
              </div>

              <div className="action-steps">
                {draft.steps.map((step, index) => (
                  <StepRow
                    key={index}
                    step={step}
                    index={index}
                    total={draft.steps.length}
                    assets={assets}
                    scenes={scenes}
                    disabled={busy}
                    onChange={next => updateStep(index, next)}
                    onMove={to => setDraft(current => (current ? { ...current, steps: moveStep(current.steps, index, to) } : current))}
                    onRemove={() => setDraft(current => (current ? { ...current, steps: removeStep(current.steps, index) } : current))}
                  />
                ))}
                {draft.steps.length === 0 && <div className="command-empty">No steps yet. Add one below.</div>}
              </div>

              <div className="action-add-step">
                <select
                  value=""
                  disabled={busy || draft.steps.length >= MAX_STEPS}
                  onChange={event => {
                    const type = event.target.value as ActionStepType;
                    if (!type) return;
                    setDraft(current => (current ? { ...current, steps: [...current.steps, newStep(type)] } : current));
                  }}
                >
                  <option value="">
                    {draft.steps.length >= MAX_STEPS ? `Step limit reached (${MAX_STEPS})` : 'Add a step…'}
                  </option>
                  {STEP_TYPES.map(type => (
                    <option key={type} value={type}>{STEP_TYPE_LABELS[type]}</option>
                  ))}
                </select>
              </div>

              {problem && <div className="command-settings-status error">{problem}</div>}

              <div className="command-settings-actions">
                <button className="modbtn gold" type="submit" disabled={busy || Boolean(problem)}>
                  {saving ? 'Saving...' : 'Save action'}
                </button>
              </div>
            </form>
              )}
            </div>
          </div>
        </div>
    </>
  );
}
