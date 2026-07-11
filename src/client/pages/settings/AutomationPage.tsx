import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Action,
  ActionRunResult,
  AlertEventKind,
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerKind,
  CategoryModule,
  ChatPhraseMatch,
  TriggerRole,
  ViewerReward,
} from '../../../shared/api';
import { DEFAULT_GLOBAL_COOLDOWN_MS, DEFAULT_USER_COOLDOWN_MS } from '../../../shared/api';
import {
  createAutomationTrigger,
  deleteAutomationTrigger,
  getActions,
  getAutomationTriggers,
  getCategoryModules,
  getViewerRewards,
  runAutomationTrigger,
  updateAutomationTrigger,
} from '../../services/dashboard';
import { SettingsHeader } from './shared';
import {
  CHAT_PHRASE_MATCHES,
  CHAT_PHRASE_MATCH_LABELS,
  TRIGGER_KINDS,
  TRIGGER_KIND_HINTS,
  TRIGGER_KIND_LABELS,
  TRIGGER_ROLES,
  describeTriggerConfig,
  formatCooldown,
  isGlobalTrigger,
  normalizeCommandName,
  triggerToInput,
  parseAliases,
  isLifecycleKind,
  runResultTone,
  summarizeRunResult,
  supportsCooldowns,
  triggerScopeLabel,
  validateTrigger,
} from './automation';

const ALERT_EVENT_KINDS: AlertEventKind[] = ['sub', 'gift', 'cheer', 'raid', 'follow'];

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

/** A blank trigger of the given kind, with the right config shape for the union. */
function newTrigger(kind: AutomationTriggerKind): AutomationTriggerInput {
  const base = {
    actionId: '',
    moduleId: null,
    enabled: true,
    globalCooldownMs: supportsCooldowns(kind) ? DEFAULT_GLOBAL_COOLDOWN_MS : 0,
    userCooldownMs: supportsCooldowns(kind) ? DEFAULT_USER_COOLDOWN_MS : 0,
  };

  switch (kind) {
    case 'reward':
      return { ...base, kind, config: { rewardId: '' } };
    case 'twitch_event':
      return { ...base, kind, config: { eventKind: 'follow' } };
    case 'chat_phrase':
      return { ...base, kind, config: { phrase: '', match: 'contains', roles: [] } };
    case 'viewer_command':
      return { ...base, kind, config: { command: '', aliases: [], roles: [] } };
    case 'dashboard_slash':
      return { ...base, kind, config: { command: '', aliases: [] } };
    case 'manual':
      return { ...base, kind, config: { label: '' } };
    case 'module_activate':
      return { ...base, kind, config: {} };
    case 'module_deactivate':
      return { ...base, kind, config: {} };
  }
}

function RoleAllowlist({
  roles,
  disabled,
  onChange,
}: {
  roles: TriggerRole[];
  disabled: boolean;
  onChange: (next: TriggerRole[]) => void;
}) {
  const toggle = (role: TriggerRole) => {
    onChange(roles.includes(role) ? roles.filter(entry => entry !== role) : [...roles, role]);
  };

  return (
    <div className="field settings-wide-field">
      <span>Who can fire it</span>
      <div className="trigger-role-list">
        {TRIGGER_ROLES.map(role => (
          <label className="trigger-role" key={role}>
            <input type="checkbox" checked={roles.includes(role)} disabled={disabled} onChange={() => toggle(role)} />
            <span>{role}</span>
          </label>
        ))}
      </div>
      <small className="action-hint">
        {roles.length === 0
          ? 'No roles selected — everyone can fire it.'
          : `Only ${roles.join(', ')} can fire it.`}
      </small>
    </div>
  );
}

function CooldownFields({
  draft,
  disabled,
  onChange,
}: {
  draft: AutomationTriggerInput;
  disabled: boolean;
  onChange: (next: AutomationTriggerInput) => void;
}) {
  return (
    <>
      <label className="field">
        <span>Global cooldown (seconds)</span>
        <input
          type="number"
          min={0}
          step={1}
          value={draft.globalCooldownMs / 1000}
          disabled={disabled}
          onChange={event => onChange({ ...draft, globalCooldownMs: Math.max(0, Math.round(Number(event.target.value) * 1000)) })}
        />
        <small className="action-hint">
          {draft.globalCooldownMs === 0
            ? 'Zero disables this cooldown — anyone can fire it back to back.'
            : `One firing per ${formatCooldown(draft.globalCooldownMs)} across the whole channel.`}
        </small>
      </label>
      <label className="field">
        <span>Per-viewer cooldown (seconds)</span>
        <input
          type="number"
          min={0}
          step={1}
          value={draft.userCooldownMs / 1000}
          disabled={disabled}
          onChange={event => onChange({ ...draft, userCooldownMs: Math.max(0, Math.round(Number(event.target.value) * 1000)) })}
        />
        <small className="action-hint">
          {draft.userCooldownMs === 0
            ? 'Zero disables this cooldown — one viewer can fire it repeatedly.'
            : `One firing per viewer per ${formatCooldown(draft.userCooldownMs)}.`}
        </small>
      </label>
    </>
  );
}

function TriggerConfigFields({
  draft,
  rewards,
  disabled,
  onChange,
}: {
  draft: AutomationTriggerInput;
  rewards: ViewerReward[];
  disabled: boolean;
  onChange: (next: AutomationTriggerInput) => void;
}) {
  switch (draft.kind) {
    case 'reward':
      return (
        <label className="field settings-wide-field">
          <span>Channel-point reward</span>
          <select
            value={draft.config.rewardId}
            disabled={disabled}
            onChange={event => onChange({ ...draft, config: { rewardId: event.target.value } })}
          >
            <option value="">Select a reward…</option>
            {/* A reward this app cannot see (deleted, or owned by another app) still
                has to stay selected, or saving would silently re-point the trigger. */}
            {draft.config.rewardId && !rewards.some(reward => reward.id === draft.config.rewardId) && (
              <option value={draft.config.rewardId}>{draft.config.rewardId} (unknown reward)</option>
            )}
            {rewards.map(reward => (
              <option key={reward.id} value={reward.id}>{reward.title}</option>
            ))}
          </select>
          {rewards.length === 0 && (
            <small className="action-hint">No rewards loaded. Connect Twitch, or create rewards in Viewer rewards.</small>
          )}
        </label>
      );

    case 'twitch_event':
      return (
        <label className="field settings-wide-field">
          <span>Twitch event</span>
          <select
            value={draft.config.eventKind}
            disabled={disabled}
            onChange={event => onChange({ ...draft, config: { eventKind: event.target.value as AlertEventKind } })}
          >
            {ALERT_EVENT_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
      );

    case 'chat_phrase':
      return (
        <>
          <label className="field">
            <span>Phrase</span>
            <input
              value={draft.config.phrase}
              disabled={disabled}
              maxLength={200}
              placeholder="gg"
              onChange={event => onChange({ ...draft, config: { ...draft.config, phrase: event.target.value } })}
            />
          </label>
          <label className="field">
            <span>Match</span>
            <select
              value={draft.config.match}
              disabled={disabled}
              onChange={event => onChange({ ...draft, config: { ...draft.config, match: event.target.value as ChatPhraseMatch } })}
            >
              {CHAT_PHRASE_MATCHES.map(match => (
                <option key={match} value={match}>{CHAT_PHRASE_MATCH_LABELS[match]}</option>
              ))}
            </select>
          </label>
          <RoleAllowlist
            roles={draft.config.roles}
            disabled={disabled}
            onChange={roles => onChange({ ...draft, config: { ...draft.config, roles } })}
          />
        </>
      );

    case 'viewer_command':
      return (
        <>
          <label className="field">
            <span>Command</span>
            <input
              value={draft.config.command}
              disabled={disabled}
              maxLength={40}
              placeholder="hype"
              onChange={event => onChange({ ...draft, config: { ...draft.config, command: normalizeCommandName(event.target.value) } })}
            />
            <small className="action-hint">Viewers type !{draft.config.command || 'command'} in chat.</small>
          </label>
          <label className="field">
            <span>Aliases</span>
            <input
              defaultValue={draft.config.aliases.join(', ')}
              disabled={disabled}
              maxLength={200}
              placeholder="h, hy"
              onBlur={event => onChange({ ...draft, config: { ...draft.config, aliases: parseAliases(event.target.value) } })}
            />
            <small className="action-hint">Comma-separated. Saved without the !.</small>
          </label>
          <RoleAllowlist
            roles={draft.config.roles}
            disabled={disabled}
            onChange={roles => onChange({ ...draft, config: { ...draft.config, roles } })}
          />
        </>
      );

    case 'dashboard_slash':
      return (
        <>
          <label className="field">
            <span>Command</span>
            <input
              value={draft.config.command}
              disabled={disabled}
              maxLength={40}
              placeholder="brb"
              onChange={event => onChange({ ...draft, config: { ...draft.config, command: normalizeCommandName(event.target.value) } })}
            />
            <small className="action-hint">
              You type /{draft.config.command || 'command'} in the dashboard. Never sent to Twitch chat.
            </small>
          </label>
          <label className="field">
            <span>Aliases</span>
            <input
              defaultValue={draft.config.aliases.join(', ')}
              disabled={disabled}
              maxLength={200}
              onBlur={event => onChange({ ...draft, config: { ...draft.config, aliases: parseAliases(event.target.value) } })}
            />
            <small className="action-hint">Comma-separated. Saved without the /.</small>
          </label>
        </>
      );

    case 'manual':
      return (
        <label className="field settings-wide-field">
          <span>Button label</span>
          <input
            value={draft.config.label}
            disabled={disabled}
            maxLength={60}
            placeholder="Hype train"
            onChange={event => onChange({ ...draft, config: { label: event.target.value } })}
          />
          <small className="action-hint">Appears as a button on the dashboard and tablet Quick actions panel.</small>
        </label>
      );

    case 'module_activate':
    case 'module_deactivate':
      return (
        <div className="field settings-wide-field">
          <small className="action-hint">
            Fires when the selected module {draft.kind === 'module_activate' ? 'becomes' : 'stops being'} the active one.
            Nothing else to configure.
          </small>
        </div>
      );
  }
}

function TriggerEditor({
  draft,
  editingId,
  actions,
  modules,
  rewards,
  saving,
  testing,
  onChange,
  onSubmit,
  onClose,
  onTest,
  onDelete,
}: {
  draft: AutomationTriggerInput;
  editingId: string | null;
  actions: Action[];
  modules: CategoryModule[];
  rewards: ViewerReward[];
  saving: boolean;
  testing: boolean;
  onChange: (next: AutomationTriggerInput) => void;
  onSubmit: () => void;
  onClose: () => void;
  /** Absent on an unsaved draft — there is nothing on the server to fire or remove yet. */
  onTest?: () => void;
  onDelete?: () => void;
}) {
  const problem = validateTrigger(draft);
  const lifecycle = isLifecycleKind(draft.kind);

  return (
    <form
      className="settings-editor-section trigger-editor"
      onSubmit={event => { event.preventDefault(); if (!problem) onSubmit(); }}
    >
      <div className="command-editor-head">
        <div>
          <div className="set-label">{editingId ? 'Edit' : 'New'} {TRIGGER_KIND_LABELS[draft.kind].toLowerCase()} trigger</div>
          <div className="set-sub">{TRIGGER_KIND_HINTS[draft.kind]}</div>
        </div>
        <div className="command-row-actions">
          {onTest && (
            <button className="modbtn gold" type="button" disabled={saving || testing} onClick={onTest}>
              {testing ? 'Running...' : 'Test'}
            </button>
          )}
          {onDelete && (
            <button className="modbtn danger" type="button" disabled={saving} onClick={onDelete}>Delete</button>
          )}
          <button className="modbtn" type="button" disabled={saving} onClick={onClose}>Close</button>
        </div>
      </div>

      <div className="settings-mini-form">
        <label className="field">
          <span>Runs this action</span>
          <select
            value={draft.actionId}
            disabled={saving}
            onChange={event => onChange({ ...draft, actionId: event.target.value })}
          >
            <option value="">Select an action…</option>
            {actions.map(action => (
              <option key={action.id} value={action.id}>
                {action.name}{action.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Scope</span>
          <select
            value={draft.moduleId ?? ''}
            disabled={saving}
            onChange={event => onChange({ ...draft, moduleId: event.target.value || null })}
          >
            {/* On a lifecycle trigger, no module means "every module" — one Action can
                announce any switch. On the other kinds it means "always armed". */}
            <option value="">{lifecycle ? 'Every module' : 'Global — always armed'}</option>
            {modules.map(module => (
              <option key={module.id} value={module.id}>{module.name}</option>
            ))}
          </select>
          <small className="action-hint">
            {lifecycle
              ? draft.moduleId
                ? 'Fires only when this module switches.'
                : 'Fires whenever any module switches.'
              : draft.moduleId
                ? 'Only fires while this module is the active one.'
                : 'Armed whatever category you are streaming.'}
          </small>
        </label>

        <label className="command-enabled">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={saving}
            onChange={event => onChange({ ...draft, enabled: event.target.checked })}
          />
          <span>Enabled</span>
        </label>

        <TriggerConfigFields draft={draft} rewards={rewards} disabled={saving} onChange={onChange} />

        {supportsCooldowns(draft.kind) && <CooldownFields draft={draft} disabled={saving} onChange={onChange} />}
      </div>

      {problem && <div className="command-settings-status error">{problem}</div>}

      <div className="command-settings-actions">
        <button className="modbtn gold" type="submit" disabled={saving || Boolean(problem)}>
          {saving ? 'Saving...' : 'Save trigger'}
        </button>
      </div>
    </form>
  );
}

export function AutomationSettingsPage() {
  const [triggers, setTriggers] = useState<AutomationTrigger[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [modules, setModules] = useState<CategoryModule[]>([]);
  const [rewards, setRewards] = useState<ViewerReward[]>([]);
  const [draft, setDraft] = useState<AutomationTriggerInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ActionRunResult>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextTriggers, nextActions, nextModules] = await Promise.all([
      getAutomationTriggers(),
      getActions(),
      getCategoryModules(),
    ]);
    setTriggers(nextTriggers);
    setActions(nextActions);
    setModules(nextModules.modules);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorText(caught, 'Could not load triggers')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // Rewards need a live Twitch connection; without them the page still works, the
  // reward picker just has nothing to offer.
  useEffect(() => {
    void getViewerRewards()
      .then(response => setRewards(response.rewards))
      .catch(() => setRewards([]));
  }, []);

  const rewardTitles = useMemo(() => {
    const titles: Record<string, string> = {};
    for (const reward of rewards) titles[reward.id] = reward.title;
    return titles;
  }, [rewards]);

  const actionNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const action of actions) names[action.id] = action.name;
    return names;
  }, [actions]);

  const busy = loading || saving;

  const startCreate = (kind: AutomationTriggerKind) => {
    setEditingId(null);
    setDraft(newTrigger(kind));
    setMessage(null);
    setError(null);
  };

  const startEdit = (trigger: AutomationTrigger) => {
    setEditingId(trigger.id);
    setDraft(triggerToInput(trigger));
    setMessage(null);
    setError(null);
  };

  const closeEditor = () => {
    setEditingId(null);
    setDraft(null);
  };

  const handleSubmit = () => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    setError(null);

    const request = editingId ? updateAutomationTrigger(editingId, draft) : createAutomationTrigger(draft);
    void request
      .then(async saved => {
        await load();
        // Stay on what was just saved rather than closing: the editor is the right pane
        // now, so closing it would blank the half of the screen you are working in — and
        // after a create, a second Save would otherwise add a duplicate trigger.
        setEditingId(saved.id);
        setDraft(triggerToInput(saved));
        setMessage('Trigger saved');
      })
      .catch(caught => setError(errorText(caught, 'Could not save the trigger')))
      .finally(() => setSaving(false));
  };

  const handleDelete = (trigger: AutomationTrigger) => {
    if (!window.confirm('Delete this trigger?')) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    void deleteAutomationTrigger(trigger.id)
      .then(() => load())
      .then(() => {
        if (editingId === trigger.id) closeEditor();
        setMessage('Trigger deleted');
      })
      .catch(caught => setError(errorText(caught, 'Could not delete the trigger')))
      .finally(() => setSaving(false));
  };

  const handleRun = (trigger: AutomationTrigger) => {
    setBusyId(trigger.id);
    setMessage(null);
    setError(null);
    void runAutomationTrigger(trigger.id)
      .then(result => setRuns(current => ({ ...current, [trigger.id]: result })))
      .catch(caught => setError(errorText(caught, 'Could not run the trigger')))
      .finally(() => setBusyId(null));
  };

  const byKind = useMemo(() => {
    const grouped = new Map<AutomationTriggerKind, AutomationTrigger[]>();
    for (const kind of TRIGGER_KINDS) grouped.set(kind, []);
    for (const trigger of triggers) grouped.get(trigger.kind)?.push(trigger);
    return grouped;
  }, [triggers]);

  // Test and Delete act on the saved trigger, so they only exist while one is open.
  const editingTrigger = editingId ? triggers.find(trigger => trigger.id === editingId) ?? null : null;
  const editingRun = editingId ? runs[editingId] ?? null : null;

  return (
    <>
        <SettingsHeader section="automation" />

        {(message || error) && (
          <div className={'command-settings-status' + (error ? ' error' : '')}>{error ?? message}</div>
        )}

        {actions.length === 0 && !loading && (
          <div className="command-settings-status error">
            No actions exist yet. A trigger has to run one — create an action first in Settings → Actions.
          </div>
        )}

        <div className="set-group">
          <div className="set-group-label">Triggers</div>

          <div className="settings-split">
            <div className="settings-split-list">
              <div className="split-list-head">
                <div className="set-sub">Pick a trigger to edit, test, or delete it. Grouped by what fires it.</div>
                {/* The kind is fixed at creation — it decides which config fields exist — so
                    New is a kind picker rather than a button. One entry point for all seven. */}
                <select
                  aria-label="New trigger"
                  className="split-new-select"
                  value=""
                  disabled={busy || actions.length === 0}
                  onChange={event => {
                    const kind = event.target.value as AutomationTriggerKind;
                    if (kind) startCreate(kind);
                  }}
                >
                  <option value="">New…</option>
                  {TRIGGER_KINDS.map(kind => (
                    <option key={kind} value={kind}>{TRIGGER_KIND_LABELS[kind]}</option>
                  ))}
                </select>
              </div>

              <div className="settings-mini-list">
                {loading ? (
                  <div className="command-empty">Loading...</div>
                ) : triggers.length === 0 ? (
                  <div className="command-empty">No triggers configured. Add one with New.</div>
                ) : TRIGGER_KINDS.map(kind => {
                  const kindTriggers = byKind.get(kind) ?? [];
                  if (kindTriggers.length === 0) return null;
                  return (
                    <React.Fragment key={kind}>
                      <div className="split-group-label">{TRIGGER_KIND_LABELS[kind]}</div>
                      {kindTriggers.map(trigger => (
                        <button
                          type="button"
                          key={trigger.id}
                          className={'settings-item-row' + (editingId === trigger.id ? ' is-selected' : '')}
                          aria-current={editingId === trigger.id ? 'true' : undefined}
                          onClick={() => startEdit(trigger)}
                        >
                          <div className="settings-item-main">
                            <b>{describeTriggerConfig(trigger, rewardTitles)}</b>
                            <span>→ {actionNames[trigger.actionId] ?? 'unknown action'}</span>
                            <div className="media-asset-tags">
                              <span
                                className={'media-asset-tag' + (isGlobalTrigger(trigger) ? ' media-asset-tag--global' : ' media-asset-tag--scoped')}
                              >
                                {triggerScopeLabel(trigger, modules)}
                              </span>
                              {!trigger.enabled && <span className="media-asset-tag media-asset-tag--off">disabled</span>}
                              {supportsCooldowns(trigger.kind) && (
                                <>
                                  <span className="media-asset-tag">
                                    global cd {formatCooldown(trigger.globalCooldownMs)}
                                  </span>
                                  <span className="media-asset-tag">
                                    per-viewer cd {formatCooldown(trigger.userCooldownMs)}
                                  </span>
                                </>
                              )}
                              {!actionNames[trigger.actionId] && (
                                <span className="media-asset-tag media-asset-tag--broken">action missing</span>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            <div className="settings-split-detail">
              {!draft ? (
                <div className="split-empty">
                  <div className="es-orb" />
                  <div className="es-title">Nothing selected</div>
                  <div className="es-sub">
                    Pick a trigger on the left to see what fires it, which action it runs, and its
                    cooldowns. New adds one.
                  </div>
                </div>
              ) : (
                <>
                  {editingRun && (
                    <div className={`action-run-result action-run-result--${runResultTone(editingRun)}`}>
                      <div className="action-run-head">
                        <span className={`action-run-status action-run-status--${runResultTone(editingRun)}`}>
                          {editingRun.status}
                        </span>
                        <span>{summarizeRunResult(editingRun)}</span>
                      </div>
                    </div>
                  )}
                  <TriggerEditor
                    draft={draft}
                    editingId={editingId}
                    actions={actions}
                    modules={modules}
                    rewards={rewards}
                    saving={saving}
                    testing={editingId !== null && busyId === editingId}
                    onChange={setDraft}
                    onSubmit={handleSubmit}
                    onClose={closeEditor}
                    onTest={editingTrigger ? () => handleRun(editingTrigger) : undefined}
                    onDelete={editingTrigger ? () => handleDelete(editingTrigger) : undefined}
                  />
                </>
              )}
            </div>
          </div>
        </div>
    </>
  );
}
