import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Action,
  AlertEventKind,
  App,
  AppEvent,
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerKind,
  CategoryModule,
  ChatPhraseMatch,
  ConditionOp,
  RedisEventTriggerConfig,
  TriggerCondition,
  TriggerOverride,
  TriggerOverrideInput,
  TriggerRole,
  TriggerAction,
  TriggerRunResult,
  ViewerReward,
} from '../../../shared/api';
import { DEFAULT_GLOBAL_COOLDOWN_MS, DEFAULT_USER_COOLDOWN_MS } from '../../../shared/api';
import {
  createAutomationTrigger,
  deleteAutomationTrigger,
  deleteTriggerOverride,
  getActions,
  getAppEvents,
  getApps,
  getAutomationTriggers,
  getCategoryModules,
  getTriggerOverrides,
  getViewerRewards,
  runAutomationTrigger,
  saveTriggerOverride,
  updateAutomationTrigger,
} from '../../services/dashboard';
import { SettingsHeader, SettingsStatus } from './shared';
import { errorMessage } from '../../errors';
import {
  CHAT_PHRASE_MATCHES,
  CHAT_PHRASE_MATCH_LABELS,
  CONDITION_FIELD_LABELS,
  CONDITION_OP_LABELS,
  CONDITION_ROLE_VALUES,
  MAX_ACTIONS_PER_TRIGGER,
  MAX_CONDITIONS,
  TRIGGER_KINDS,
  TRIGGER_KIND_HINTS,
  TRIGGER_KIND_LABELS,
  TRIGGER_ROLES,
  conditionFieldsForKind,
  describeTriggerConfig,
  formatCooldown,
  isGlobalTrigger,
  moveStep,
  normalizeCommandName,
  opsForField,
  redisUnsafeStepWarning,
  removeStep,
  triggerToInput,
  parseAliases,
  isLifecycleKind,
  runResultTone,
  summarizeRunResult,
  supportsCooldowns,
  supportsOverrides,
  triggerScopeLabel,
  validateTrigger,
} from './automation';

const ALERT_EVENT_KINDS: AlertEventKind[] = ['sub', 'gift', 'cheer', 'raid', 'follow'];

/** A blank trigger of the given kind, with the right config shape for the union. */
export function newTrigger(kind: AutomationTriggerKind): AutomationTriggerInput {
  const base = {
    name: '',
    // Legacy single-Action pointer, additive alongside actions[] (Phase B1 Task 2).
    // The server derives it from actions[0] and never reads it from the request body,
    // so an empty placeholder here is fine — validateTrigger blocks submit until at
    // least one entry is added to actions[].
    actionId: '',
    actions: [] as TriggerAction[],
    conditions: [] as TriggerCondition[],
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
    case 'redis_event':
      return { ...base, kind, config: { appId: '', eventName: '' } };
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

/**
 * App + declared-event pickers for a redis_event trigger, plus the advisory
 * safe-subset warning. The event `<select>` reloads from getAppEvents whenever the
 * chosen app changes — picking a different app also clears eventName, since a
 * declared event name from the old app has no meaning under the new one.
 */
function RedisEventConfigFields({
  config,
  apps,
  actions,
  triggerActions,
  disabled,
  onChange,
}: {
  config: RedisEventTriggerConfig;
  apps: App[];
  actions: Action[];
  triggerActions: TriggerAction[];
  disabled: boolean;
  onChange: (next: RedisEventTriggerConfig) => void;
}) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  useEffect(() => {
    if (!config.appId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setLoadingEvents(true);
    void getAppEvents(config.appId)
      .then(next => { if (!cancelled) setEvents(next); })
      .catch(() => { if (!cancelled) setEvents([]); })
      .finally(() => { if (!cancelled) setLoadingEvents(false); });
    return () => { cancelled = true; };
  }, [config.appId]);

  const warning = redisUnsafeStepWarning(triggerActions, actions);

  return (
    <>
      <label className="field settings-wide-field">
        <span>App</span>
        <select
          value={config.appId}
          disabled={disabled}
          onChange={event => onChange({ appId: event.target.value, eventName: '' })}
        >
          <option value="">Select an app…</option>
          {/* An app this operator can no longer see (deleted from under it) still has to
              stay selected, or saving would silently re-point the trigger. */}
          {config.appId && !apps.some(app => app.id === config.appId) && (
            <option value={config.appId}>{config.appId} (unknown app)</option>
          )}
          {apps.filter(app => !app.disabledAt).map(app => (
            <option key={app.id} value={app.id}>{app.name}</option>
          ))}
        </select>
        {apps.length === 0 && (
          <small className="action-hint">No apps registered. Register one in Settings → Apps.</small>
        )}
      </label>

      <label className="field settings-wide-field">
        <span>Event</span>
        <select
          value={config.eventName}
          disabled={disabled || !config.appId}
          onChange={event => onChange({ ...config, eventName: event.target.value })}
        >
          <option value="">
            {!config.appId ? 'Pick an app first…' : loadingEvents ? 'Loading…' : 'Select an event…'}
          </option>
          {config.eventName && !events.some(entry => entry.eventName === config.eventName) && (
            <option value={config.eventName}>{config.eventName} (undeclared)</option>
          )}
          {events.map(entry => (
            <option key={entry.eventName} value={entry.eventName}>{entry.eventName}</option>
          ))}
        </select>
        {config.appId && !loadingEvents && events.length === 0 && (
          <small className="action-hint">
            No events declared for this app yet. Declare one in Settings → Apps.
          </small>
        )}
      </label>

      {/* Advisory only — the server is the authority that skips a blocked step at
          dispatch time. This never blocks Save; a mixed Action is legal here. */}
      {warning && <small className="action-hint">{warning}</small>}
    </>
  );
}

function TriggerConfigFields({
  draft,
  rewards,
  apps,
  actions,
  disabled,
  onChange,
}: {
  draft: AutomationTriggerInput;
  rewards: ViewerReward[];
  apps: App[];
  actions: Action[];
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

    case 'redis_event':
      return (
        <RedisEventConfigFields
          config={draft.config}
          apps={apps}
          actions={actions}
          triggerActions={draft.actions}
          disabled={disabled}
          onChange={config => onChange({ ...draft, config })}
        />
      );
  }
}

/**
 * The ordered list of actions a trigger runs, modelled on ActionsPage's step-list
 * editor: per-row enable checkbox + Up/Down/Remove, plus an add-select that excludes
 * actions already on the trigger. Position always mirrors array order — the server
 * re-derives `position` from that order on save (see normalizeAutomationTriggerInput),
 * so nothing here needs to keep a client-computed number in sync with anything.
 */
function TriggerActionsEditor({
  triggerActions,
  actions,
  disabled,
  onChange,
}: {
  triggerActions: TriggerAction[];
  actions: Action[];
  disabled: boolean;
  onChange: (next: TriggerAction[]) => void;
}) {
  const actionName = (id: string) => actions.find(action => action.id === id)?.name;
  const available = actions.filter(action => !triggerActions.some(entry => entry.actionId === action.id));
  const allDisabled = triggerActions.length > 0 && triggerActions.every(entry => !entry.enabled);
  const atLimit = triggerActions.length >= MAX_ACTIONS_PER_TRIGGER;

  // Position is display/run order (array index) — reassign it after every
  // reorder/add/remove so a saved draft's `position` never drifts from where the row
  // actually sits, even though the server would re-derive it anyway.
  const reindex = (next: TriggerAction[]): TriggerAction[] =>
    next.map((entry, index) => ({ ...entry, position: index }));

  return (
    <div className="field settings-wide-field">
      <span>Runs these actions</span>
      <div className="action-steps">
        {triggerActions.map((entry, index) => (
          <div key={entry.actionId} className={'action-step' + (entry.enabled ? '' : ' action-step--off')}>
            <div className="action-step-head">
              <span className="action-step-index">{index + 1}</span>
              <span className="action-step-name" style={{ flex: '1 1 200px', minWidth: 0, fontWeight: 600 }}>
                {actionName(entry.actionId) ?? 'unknown action'}
              </span>
              <label className="command-enabled">
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  disabled={disabled}
                  onChange={event => onChange(
                    triggerActions.map((item, i) => (i === index ? { ...item, enabled: event.target.checked } : item)),
                  )}
                />
                <span>On</span>
              </label>
              <div className="command-row-actions">
                <button
                  className="modbtn"
                  type="button"
                  title="Move up"
                  disabled={disabled || index === 0}
                  onClick={() => onChange(reindex(moveStep(triggerActions, index, index - 1)))}
                >
                  ↑
                </button>
                <button
                  className="modbtn"
                  type="button"
                  title="Move down"
                  disabled={disabled || index === triggerActions.length - 1}
                  onClick={() => onChange(reindex(moveStep(triggerActions, index, index + 1)))}
                >
                  ↓
                </button>
                <button
                  className="modbtn danger"
                  type="button"
                  title={triggerActions.length === 1 ? 'A trigger needs at least one action' : 'Remove'}
                  disabled={disabled || triggerActions.length === 1}
                  onClick={() => onChange(reindex(removeStep(triggerActions, index)))}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
        {triggerActions.length === 0 && <div className="command-empty">No actions yet. Add one below.</div>}
      </div>

      {allDisabled && <small className="action-hint">Won't fire — all actions are disabled.</small>}

      <select
        value=""
        disabled={disabled || atLimit || available.length === 0}
        onChange={event => {
          const actionId = event.target.value;
          if (!actionId) return;
          onChange(reindex([...triggerActions, { actionId, position: triggerActions.length, enabled: true }]));
        }}
      >
        <option value="">
          {atLimit
            ? `Action limit reached (${MAX_ACTIONS_PER_TRIGGER})`
            : available.length === 0
              ? 'All actions already added'
              : 'Add an action…'}
        </option>
        {available.map(action => (
          <option key={action.id} value={action.id}>
            {action.name}{action.enabled ? '' : ' (disabled)'}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A fresh value of the right shape for a newly chosen op, so switching ops never
 *  leaves a value of the wrong type behind (a leftover string[] under `eq`, or a
 *  leftover string under `in`). */
function defaultConditionValue(op: ConditionOp): TriggerCondition['value'] {
  switch (op) {
    case 'in': return [];
    case 'gte':
    case 'lte': return 0;
    case 'role_is': return CONDITION_ROLE_VALUES[0];
    default: return '';
  }
}

/** A blank condition for this trigger kind: its first available field, that field's
 *  first available op, and a value of the right shape for that op. */
function newCondition(kind: AutomationTriggerKind): TriggerCondition {
  const field = conditionFieldsForKind(kind)[0] ?? 'actor';
  const op = opsForField(kind, field)[0] ?? 'eq';
  return { field, op, value: defaultConditionValue(op) };
}

/**
 * The `in` op's value editor, kept as its OWN component rather than inline JSX in
 * ConditionValueInput. React tells rows apart by element TYPE at a given tree
 * position, not by which `if` branch produced them — a plain `<input>` reused
 * across an op switch (e.g. `contains` → `in`) is the SAME DOM node to React, so an
 * uncontrolled `defaultValue` on it keeps whatever the browser last had typed into
 * it. Giving `in` its own component type forces React to unmount the old node and
 * mount this one fresh whenever a row's op becomes (or stops being) `in`, so its
 * `useState` initializer reliably reseeds from the row's current value.
 *
 * The text is kept in local state and reparsed on every keystroke — rather than a
 * fully-controlled `value={list.join(', ')}` — because immediately rejoining the
 * parsed array back into the displayed string would eat a trailing comma the
 * instant it is typed (`"a,"` → parses to `["a"]` → redisplays as `"a"`), making it
 * impossible to ever start a second entry.
 */
function InListValueInput({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState(() => value.join(', '));

  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      placeholder="value1, value2"
      onChange={event => {
        setText(event.target.value);
        onChange(event.target.value.split(',').map(entry => entry.trim()).filter(Boolean));
      }}
    />
  );
}

/** The value editor for one condition row, typed by its op: a role picker for
 *  role_is, a single tag field for tag_has, a number field for gte/lte, a
 *  comma-separated list for `in`, and plain text otherwise. */
function ConditionValueInput({
  condition,
  disabled,
  onChange,
}: {
  condition: TriggerCondition;
  disabled: boolean;
  onChange: (value: TriggerCondition['value']) => void;
}) {
  if (condition.op === 'role_is') {
    return (
      <select value={String(condition.value)} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {CONDITION_ROLE_VALUES.map(role => <option key={role} value={role}>{role}</option>)}
      </select>
    );
  }

  if (condition.op === 'tag_has') {
    return (
      <input
        type="text"
        value={typeof condition.value === 'string' ? condition.value : ''}
        disabled={disabled}
        placeholder="tag"
        onChange={event => onChange(event.target.value)}
      />
    );
  }

  if (condition.op === 'in') {
    const listValue = Array.isArray(condition.value) ? condition.value : [];
    return <InListValueInput value={listValue} disabled={disabled} onChange={onChange} />;
  }

  if (condition.op === 'gte' || condition.op === 'lte') {
    // Controlled directly off the stored value rather than through `Number(...) ||
    // 0`: coercing a NaN-producing value to 0 would silently rewrite what the
    // operator typed. validateConditions already flags a non-numeric gte/lte inline
    // — this input's job is to preserve exactly what was typed for that message to
    // refer to, not to sanitize it.
    return (
      <input
        type="number"
        value={typeof condition.value === 'number' || typeof condition.value === 'string' ? condition.value : ''}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
    );
  }

  return (
    <input
      type="text"
      value={typeof condition.value === 'string' ? condition.value : ''}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
    />
  );
}

/**
 * The trigger's optional AND-only event filter: a list of (field, op, value) rows,
 * kind-aware in both the field and op vocabulary (mirrors the server's
 * normalizeConditions — see automation.ts). An empty list is the normal case and
 * means no extra filter, so it is never presented as a problem.
 */
function ConditionsEditor({
  kind,
  conditions,
  disabled,
  onChange,
}: {
  kind: AutomationTriggerKind;
  conditions: TriggerCondition[];
  disabled: boolean;
  onChange: (next: TriggerCondition[]) => void;
}) {
  const atLimit = conditions.length >= MAX_CONDITIONS;
  const fieldOptions = conditionFieldsForKind(kind);

  // Conditions are plain {field,op,value} objects with no id of their own — and none
  // is added to the wire format sent to the server. A client-only id is generated once
  // per row here and kept in lockstep with add/remove, so each row's DOM subtree (in
  // particular an `in` row's InListValueInput local state) stays keyed to the SAME row
  // across a reorder rather than to an array index. Without this, removing row 2 of 3
  // shifts row 3 into row 2's old index-keyed slot, and if that shifted-in row is also
  // an `in` condition, it would inherit row 2's still-mounted typed text instead of
  // its own. The parent keys this whole component by which trigger is being edited
  // (see TriggerEditor), so switching triggers gets a fresh id list for free.
  const [rowIds, setRowIds] = useState<string[]>(() => conditions.map(() => crypto.randomUUID()));

  const updateAt = (index: number, next: TriggerCondition) => {
    onChange(conditions.map((entry, i) => (i === index ? next : entry)));
  };

  const addRow = () => {
    setRowIds(ids => [...ids, crypto.randomUUID()]);
    onChange([...conditions, newCondition(kind)]);
  };

  const removeRow = (index: number) => {
    setRowIds(ids => ids.filter((_, i) => i !== index));
    onChange(removeStep(conditions, index));
  };

  return (
    <div className="field settings-wide-field">
      <span>Conditions</span>
      <div className="action-steps">
        {conditions.map((condition, index) => (
          <div className="action-step" key={rowIds[index] ?? index}>
            <div className="action-step-head">
              <select
                value={condition.field}
                disabled={disabled}
                onChange={event => {
                  const field = event.target.value;
                  const op = opsForField(kind, field)[0] ?? 'eq';
                  updateAt(index, { field, op, value: defaultConditionValue(op) });
                }}
              >
                {fieldOptions.map(field => (
                  <option key={field} value={field}>{CONDITION_FIELD_LABELS[field] ?? field}</option>
                ))}
              </select>
              <select
                value={condition.op}
                disabled={disabled}
                onChange={event => {
                  const op = event.target.value as ConditionOp;
                  updateAt(index, { field: condition.field, op, value: defaultConditionValue(op) });
                }}
              >
                {opsForField(kind, condition.field).map(op => (
                  <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>
                ))}
              </select>
              <ConditionValueInput
                condition={condition}
                disabled={disabled}
                onChange={value => updateAt(index, { ...condition, value })}
              />
              <div className="command-row-actions">
                <button
                  className="modbtn danger"
                  type="button"
                  disabled={disabled}
                  onClick={() => removeRow(index)}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
        {conditions.length === 0 && (
          <div className="command-empty">No conditions — fires on every match.</div>
        )}
      </div>

      <div className="settings-wide-field">
        <button
          className="modbtn"
          type="button"
          disabled={disabled || atLimit}
          onClick={addRow}
        >
          {atLimit ? `Condition limit reached (${MAX_CONDITIONS})` : 'Add condition'}
        </button>
      </div>
      <small className="action-hint">
        All conditions must match (AND). An empty list is normal — it just means no extra filter.
      </small>
    </div>
  );
}

/**
 * Per-viewer overrides for one saved trigger. Rows save immediately via their own
 * endpoint — they are separate resources, deliberately outside the trigger form's
 * draft/save cycle so an override edit cannot be lost to an unsaved trigger draft.
 */
function TriggerOverridesSection({
  triggerId,
  overrides,
  actions,
  disabled,
  onSave,
  onDelete,
}: {
  triggerId: string;
  overrides: TriggerOverride[];
  actions: Action[];
  disabled: boolean;
  onSave: (triggerId: string, input: TriggerOverrideInput) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [newLogin, setNewLogin] = useState('');
  const [newActionId, setNewActionId] = useState('');

  const addProblem = (() => {
    if (!newLogin.trim()) return null; // untouched: no nagging
    const login = newLogin.trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return 'Logins use letters, numbers, or underscores.';
    if (overrides.some(existing => existing.login === login)) return `${login} already has an override on this trigger.`;
    return null;
  })();

  const add = async () => {
    if (addProblem || !newLogin.trim() || !newActionId) return;
    const saved = await onSave(triggerId, {
      login: newLogin.trim().replace(/^@+/, '').toLowerCase(),
      actionId: newActionId,
      enabled: true,
      note: '',
    });
    // Only clear on a confirmed save: a failed one must leave the operator's typed
    // input in place next to the error banner rather than silently discarding it.
    if (!saved) return;
    setNewLogin('');
    setNewActionId('');
  };

  return (
    <div className="field">
      <span>Per-viewer overrides</span>
      {overrides.map(override => (
        <div className="command-row-actions" key={override.id}>
          <code>{override.login}</code>
          <select
            value={override.actionId}
            disabled={disabled}
            onChange={event => onSave(triggerId, {
              login: override.login, actionId: event.target.value, enabled: override.enabled, note: override.note,
            })}
          >
            {actions.map(action => (
              <option key={action.id} value={action.id}>
                {action.name}{action.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
          <label className="command-enabled">
            <input
              type="checkbox"
              checked={override.enabled}
              disabled={disabled}
              onChange={event => onSave(triggerId, {
                login: override.login, actionId: override.actionId, enabled: event.target.checked, note: override.note,
              })}
            />
            <span>On</span>
          </label>
          <button className="modbtn danger" type="button" disabled={disabled} onClick={() => onDelete(override.id)}>
            Remove
          </button>
        </div>
      ))}
      <div className="command-row-actions">
        <input
          type="text"
          value={newLogin}
          maxLength={26}
          placeholder="viewer login"
          disabled={disabled}
          onChange={event => setNewLogin(event.target.value)}
        />
        <select value={newActionId} disabled={disabled} onChange={event => setNewActionId(event.target.value)}>
          <option value="">Runs this action instead…</option>
          {actions.map(action => (
            <option key={action.id} value={action.id}>
              {action.name}{action.enabled ? '' : ' (disabled)'}
            </option>
          ))}
        </select>
        <button
          className="modbtn"
          type="button"
          disabled={disabled || Boolean(addProblem) || !newLogin.trim() || !newActionId}
          onClick={() => void add()}
        >
          Add
        </button>
      </div>
      {addProblem && <small className="action-hint">{addProblem}</small>}
      <small className="action-hint">
        If the override's action can't run (skipped), the trigger's normal action plays
        instead. Cooldowns are shared with this trigger.
      </small>
    </div>
  );
}

function TriggerEditor({
  draft,
  editingId,
  actions,
  modules,
  rewards,
  apps,
  saving,
  testing,
  overrides,
  overrideBusy,
  onChange,
  onSubmit,
  onClose,
  onTest,
  onDelete,
  onSaveOverride,
  onDeleteOverride,
}: {
  draft: AutomationTriggerInput;
  editingId: string | null;
  actions: Action[];
  modules: CategoryModule[];
  rewards: ViewerReward[];
  apps: App[];
  saving: boolean;
  testing: boolean;
  overrides: TriggerOverride[];
  overrideBusy: boolean;
  onChange: (next: AutomationTriggerInput) => void;
  onSubmit: () => void;
  onClose: () => void;
  /** Absent on an unsaved draft — there is nothing on the server to fire or remove yet. */
  onTest?: () => void;
  onDelete?: () => void;
  onSaveOverride: (triggerId: string, input: TriggerOverrideInput) => Promise<boolean>;
  onDeleteOverride: (id: string) => Promise<boolean>;
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
          <span>Name</span>
          <input
            type="text"
            value={draft.name}
            disabled={saving}
            placeholder="What is this trigger for?"
            onChange={event => onChange({ ...draft, name: event.target.value })}
          />
        </label>

        <TriggerActionsEditor
          triggerActions={draft.actions}
          actions={actions}
          disabled={saving}
          onChange={next => onChange({ ...draft, actions: next })}
        />

        <ConditionsEditor
          // Keyed by which trigger is open (not by `draft.kind` — the kind is fixed
          // per trigger, so this is equivalent to keying by identity): TriggerEditor
          // itself never unmounts as the operator clicks between triggers in the list
          // (see AutomationSettingsPage), so without this key ConditionsEditor's row
          // ids would carry over from whichever trigger was open a moment ago.
          key={editingId ?? 'new'}
          kind={draft.kind}
          conditions={draft.conditions}
          disabled={saving}
          onChange={next => onChange({ ...draft, conditions: next })}
        />

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

        <TriggerConfigFields draft={draft} rewards={rewards} apps={apps} actions={actions} disabled={saving} onChange={onChange} />

        {supportsCooldowns(draft.kind) && <CooldownFields draft={draft} disabled={saving} onChange={onChange} />}

        {supportsOverrides(draft.kind) && (
          editingId ? (
            <TriggerOverridesSection
              triggerId={editingId}
              overrides={overrides}
              actions={actions}
              disabled={saving || overrideBusy}
              onSave={onSaveOverride}
              onDelete={onDeleteOverride}
            />
          ) : (
            <small className="action-hint">Save the trigger first, then add per-viewer overrides.</small>
          )
        )}
      </div>

      <SettingsStatus error={problem} />

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
  const [apps, setApps] = useState<App[]>([]);
  const [overrides, setOverrides] = useState<TriggerOverride[]>([]);
  const [draft, setDraft] = useState<AutomationTriggerInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, TriggerRunResult>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Gates the override rows while a PUT/DELETE is in flight, so a fast double-toggle
  // cannot race two saves into a last-response-wins overwrite.
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextTriggers, nextActions, nextModules, nextOverrides] = await Promise.all([
      getAutomationTriggers(),
      getActions(),
      getCategoryModules(),
      getTriggerOverrides(),
    ]);
    setTriggers(nextTriggers);
    setActions(nextActions);
    setModules(nextModules.modules);
    setOverrides(nextOverrides);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, 'Could not load triggers')); })
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

  // The redis_event app picker's option list; without it the picker just has
  // nothing to offer, same as the reward picker above.
  useEffect(() => {
    void getApps()
      .then(setApps)
      .catch(() => setApps([]));
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
      .catch(caught => setError(errorMessage(caught, 'Could not save the trigger')))
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
      .catch(caught => setError(errorMessage(caught, 'Could not delete the trigger')))
      .finally(() => setSaving(false));
  };

  const handleRun = (trigger: AutomationTrigger) => {
    setBusyId(trigger.id);
    setMessage(null);
    setError(null);
    void runAutomationTrigger(trigger.id)
      .then(result => setRuns(current => ({ ...current, [trigger.id]: result })))
      .catch(caught => setError(errorMessage(caught, 'Could not run the trigger')))
      .finally(() => setBusyId(null));
  };

  // Both report success back to the caller: the add row must only clear its inputs
  // once the save actually landed, not merely once the request was fired.
  const saveOverride = useCallback(async (triggerId: string, input: TriggerOverrideInput) => {
    setOverrideBusy(true);
    try {
      await saveTriggerOverride(triggerId, input);
      setOverrides(await getTriggerOverrides());
      setError(null);
      return true;
    } catch (caught) {
      setError(errorMessage(caught, 'Could not save the override.'));
      return false;
    } finally {
      setOverrideBusy(false);
    }
  }, []);

  const removeOverride = useCallback(async (id: string) => {
    setOverrideBusy(true);
    try {
      await deleteTriggerOverride(id);
      setOverrides(await getTriggerOverrides());
      setError(null);
      return true;
    } catch (caught) {
      setError(errorMessage(caught, 'Could not remove the override.'));
      return false;
    } finally {
      setOverrideBusy(false);
    }
  }, []);

  const byKind = useMemo(() => {
    const grouped = new Map<AutomationTriggerKind, AutomationTrigger[]>();
    for (const kind of TRIGGER_KINDS) grouped.set(kind, []);
    for (const trigger of triggers) grouped.get(trigger.kind)?.push(trigger);
    return grouped;
  }, [triggers]);

  const overrideCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const override of overrides) counts[override.triggerId] = (counts[override.triggerId] ?? 0) + 1;
    return counts;
  }, [overrides]);

  // Test and Delete act on the saved trigger, so they only exist while one is open.
  const editingTrigger = editingId ? triggers.find(trigger => trigger.id === editingId) ?? null : null;
  const editingRun = editingId ? runs[editingId] ?? null : null;

  return (
    <>
        <SettingsHeader section="automation" />

        <SettingsStatus message={message} error={error} />

        {actions.length === 0 && !loading && (
          <SettingsStatus error="No actions exist yet. A trigger has to run one — create an action first in Settings → Actions." />
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
                      {kindTriggers.map(trigger => {
                        const actionLabel = trigger.actions.length === 0
                          ? 'no actions'
                          : trigger.actions.map(entry => actionNames[entry.actionId] ?? 'unknown action').join(', ');
                        const missingAction = trigger.actions.some(entry => !actionNames[entry.actionId]);
                        const allActionsDisabled = trigger.actions.length > 0 && trigger.actions.every(entry => !entry.enabled);
                        return (
                          <button
                            type="button"
                            key={trigger.id}
                            className={'settings-item-row' + (editingId === trigger.id ? ' is-selected' : '')}
                            aria-current={editingId === trigger.id ? 'true' : undefined}
                            onClick={() => startEdit(trigger)}
                          >
                            <div className="settings-item-main">
                              <b>{trigger.name}</b>
                              <span>{describeTriggerConfig(trigger, rewardTitles)}</span>
                              <span>→ {actionLabel}</span>
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
                                {missingAction && (
                                  <span className="media-asset-tag media-asset-tag--broken">action missing</span>
                                )}
                                {allActionsDisabled && (
                                  <span className="media-asset-tag media-asset-tag--off">won't fire — all actions disabled</span>
                                )}
                                {(overrideCounts[trigger.id] ?? 0) > 0 && (
                                  <span className="media-asset-tag">
                                    {overrideCounts[trigger.id]} viewer override{overrideCounts[trigger.id] === 1 ? '' : 's'}
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
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
                    apps={apps}
                    saving={saving}
                    testing={editingId !== null && busyId === editingId}
                    overrides={editingId ? overrides.filter(o => o.triggerId === editingId) : []}
                    overrideBusy={overrideBusy}
                    onChange={setDraft}
                    onSubmit={handleSubmit}
                    onClose={closeEditor}
                    onTest={editingTrigger ? () => handleRun(editingTrigger) : undefined}
                    onDelete={editingTrigger ? () => handleDelete(editingTrigger) : undefined}
                    onSaveOverride={saveOverride}
                    onDeleteOverride={removeOverride}
                  />
                </>
              )}
            </div>
          </div>
        </div>
    </>
  );
}
