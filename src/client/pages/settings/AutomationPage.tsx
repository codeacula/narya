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
  parseAliases,
  requiresModule,
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

function triggerToInput(trigger: AutomationTrigger): AutomationTriggerInput {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = trigger;
  return input as AutomationTriggerInput;
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
  onChange,
  onSubmit,
  onClose,
}: {
  draft: AutomationTriggerInput;
  editingId: string | null;
  actions: Action[];
  modules: CategoryModule[];
  rewards: ViewerReward[];
  saving: boolean;
  onChange: (next: AutomationTriggerInput) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const problem = validateTrigger(draft);
  const moduleRequired = requiresModule(draft.kind);

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
        <button className="modbtn" type="button" disabled={saving} onClick={onClose}>Close</button>
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
            {/* A lifecycle trigger has no module-less meaning, so it gets no Global option. */}
            {!moduleRequired && <option value="">Global — always armed</option>}
            {moduleRequired && <option value="">Select a module…</option>}
            {modules.map(module => (
              <option key={module.id} value={module.id}>{module.name}</option>
            ))}
          </select>
          <small className="action-hint">
            {moduleRequired
              ? 'Lifecycle triggers fire from a module, so one is required.'
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

export function AutomationSettingsPage({ onBack }: { onBack: () => void }) {
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
      .then(() => load())
      .then(() => {
        closeEditor();
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

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="rewards-header">
          <div>
            <div className="settings-eyebrow">settings</div>
            <h2 className="settings-title">Automation</h2>
            <p className="set-intro">
              A trigger is a source that fires one action. A trigger with no module is <b>global</b> — always armed.
              A module-scoped one only fires while its module is the active one.
            </p>
          </div>
          <button className="modbtn" type="button" onClick={onBack}>Back</button>
        </div>

        {(message || error) && (
          <div className={'command-settings-status' + (error ? ' error' : '')}>{error ?? message}</div>
        )}

        {actions.length === 0 && !loading && (
          <div className="command-settings-status error">
            No actions exist yet. A trigger has to run one — create an action first in Settings → Actions.
          </div>
        )}

        {draft && (
          <div className="set-group">
            <div className="set-group-label">{editingId ? 'Edit trigger' : 'New trigger'}</div>
            <TriggerEditor
              draft={draft}
              editingId={editingId}
              actions={actions}
              modules={modules}
              rewards={rewards}
              saving={saving}
              onChange={setDraft}
              onSubmit={handleSubmit}
              onClose={closeEditor}
            />
          </div>
        )}

        {TRIGGER_KINDS.map(kind => {
          const kindTriggers = byKind.get(kind) ?? [];
          return (
            <div className="set-group" key={kind}>
              <div className="set-group-label">{TRIGGER_KIND_LABELS[kind]}</div>

              <div className="settings-editor-section">
                <div className="command-editor-head">
                  <div>
                    <div className="set-sub">{TRIGGER_KIND_HINTS[kind]}</div>
                  </div>
                  <button
                    className="modbtn"
                    type="button"
                    disabled={busy || actions.length === 0}
                    onClick={() => startCreate(kind)}
                  >
                    New
                  </button>
                </div>

                <div className="settings-mini-list">
                  {loading ? (
                    <div className="command-empty">Loading...</div>
                  ) : kindTriggers.length === 0 ? (
                    <div className="command-empty">None configured.</div>
                  ) : kindTriggers.map(trigger => (
                    <React.Fragment key={trigger.id}>
                      <div className="settings-item-row">
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
                        <div className="command-row-actions">
                          <button
                            className="modbtn gold"
                            type="button"
                            disabled={busy || busyId === trigger.id}
                            onClick={() => handleRun(trigger)}
                          >
                            {busyId === trigger.id ? 'Running...' : 'Test'}
                          </button>
                          <button className="modbtn" type="button" disabled={busy} onClick={() => startEdit(trigger)}>
                            Edit
                          </button>
                          <button className="modbtn danger" type="button" disabled={busy} onClick={() => handleDelete(trigger)}>
                            Delete
                          </button>
                        </div>
                      </div>
                      {runs[trigger.id] && (
                        <div className={`action-run-result action-run-result--${runResultTone(runs[trigger.id])}`}>
                          <div className="action-run-head">
                            <span className={`action-run-status action-run-status--${runResultTone(runs[trigger.id])}`}>
                              {runs[trigger.id].status}
                            </span>
                            <span>{summarizeRunResult(runs[trigger.id])}</span>
                          </div>
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
