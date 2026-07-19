import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CategoryModule,
  CategoryModuleInput,
  CategoryModulesResponse,
  CategoryModuleStatus,
  RewardStreamCategory,
  TwitchCategorySuggestion,
  ViewerRewardCategory,
} from '../../../shared/api';
import {
  createCategoryModule,
  deleteCategoryModule,
  getCategoryModules,
  getCategorySuggestions,
  getViewerRewards,
  reconcileCategoryModules,
  updateCategoryModule,
} from '../../services/dashboard';
import { useSocket } from '../../realtime';
import { useDebouncedSuggestions } from '../../suggestions';
import { SettingsHeader, SettingsStatus } from './shared';
import { errorMessage } from '../../errors';

const EMPTY_RESPONSE: CategoryModulesResponse = {
  modules: [],
  activeModuleId: null,
  activeGameId: null,
  activeGameName: null,
  lastSignalSource: null,
  lookupError: null,
  lastReconciledAt: null,
};

const EMPTY_DRAFT: CategoryModuleInput = { name: '', enabled: true, games: [], rewardGroupIds: [] };

const STATUS_HINTS: Record<CategoryModuleStatus, string> = {
  idle: 'Not the active module. Its reward groups are off and its module-scoped triggers are disarmed.',
  active: 'The live Twitch category belongs to this module. Its reward groups are on.',
  degraded: 'The last reconciliation did not complete. The module kept its previous state — retry to re-apply it.',
};

function moduleToInput(module: CategoryModule): CategoryModuleInput {
  return {
    name: module.name,
    enabled: module.enabled,
    games: module.games,
    rewardGroupIds: module.rewardGroups.map(group => group.id),
  };
}

/** Type-ahead over Twitch categories. A game already claimed elsewhere is marked, not hidden — the
 *  server is the authority on the claim and returns 409, so the picker only warns. */
function GamePicker({
  games,
  claimedElsewhere,
  disabled,
  onChange,
}: {
  games: RewardStreamCategory[];
  claimedElsewhere: Map<string, string>;
  disabled: boolean;
  onChange: (next: RewardStreamCategory[]) => void;
}) {
  const [query, setQuery] = useState('');
  const fetcher = useCallback((value: string) => getCategorySuggestions(value), []);
  const { suggestions, loading } = useDebouncedSuggestions<TwitchCategorySuggestion>(query, fetcher);

  const add = (suggestion: TwitchCategorySuggestion) => {
    if (games.some(game => game.id === suggestion.id)) return;
    onChange([...games, { id: suggestion.id, name: suggestion.name }]);
    setQuery('');
  };

  return (
    <div className="field settings-wide-field">
      <span>Twitch categories that activate this module</span>

      <div className="module-game-list">
        {games.length === 0 ? (
          <div className="command-empty">No categories claimed. This module can never become active.</div>
        ) : games.map(game => {
          const owner = claimedElsewhere.get(game.id);
          return (
            <span className={'module-game' + (owner ? ' module-game--conflict' : '')} key={game.id}>
              {game.name}
              {owner && <em> — claimed by {owner}</em>}
              <button
                className="module-game-remove"
                type="button"
                disabled={disabled}
                title={`Remove ${game.name}`}
                onClick={() => onChange(games.filter(entry => entry.id !== game.id))}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>

      <input
        value={query}
        disabled={disabled}
        placeholder="Search Twitch categories…"
        onChange={event => setQuery(event.target.value)}
      />

      {(loading || suggestions.length > 0) && (
        <div className="module-suggestions">
          {loading && <div className="command-empty">Searching…</div>}
          {suggestions.map(suggestion => {
            const owner = claimedElsewhere.get(suggestion.id);
            const already = games.some(game => game.id === suggestion.id);
            return (
              <button
                className="module-suggestion"
                type="button"
                key={suggestion.id}
                disabled={disabled || already}
                onClick={() => add(suggestion)}
              >
                <span>{suggestion.name}</span>
                {already && <span className="media-asset-tag">added</span>}
                {!already && owner && <span className="media-asset-tag media-asset-tag--broken">claimed by {owner}</span>}
              </button>
            );
          })}
        </div>
      )}

      <small className="action-hint">
        A Twitch category belongs to at most one module. Claiming one that another module already owns is refused.
      </small>
    </div>
  );
}

function StatusBadge({ module, active }: { module: CategoryModule; active: boolean }) {
  return (
    <div className="media-asset-tags">
      <span className={`module-status module-status--${module.status}`}>{module.status}</span>
      {active && <span className="module-status module-status--live">live now</span>}
      {!module.enabled && <span className="media-asset-tag media-asset-tag--off">disabled</span>}
    </div>
  );
}

export function ModulesSettingsPage() {
  const [state, setState] = useState<CategoryModulesResponse>(EMPTY_RESPONSE);
  const [groups, setGroups] = useState<ViewerRewardCategory[]>([]);
  const [draft, setDraft] = useState<CategoryModuleInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState(await getCategoryModules());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, 'Could not load category modules')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // Reward groups come from the Viewer rewards categories; without Twitch they are
  // simply unavailable and the module can still be edited.
  useEffect(() => {
    void getViewerRewards()
      .then(response => setGroups(response.categories))
      .catch(() => setGroups([]));
  }, []);

  // Status changes when the category flips mid-stream, so take the push rather than
  // leaving a stale `idle` on screen.
  useSocket<CategoryModulesResponse>('category-modules:updated', useCallback((payload) => {
    setState(payload);
  }, []));

  const busy = loading || saving || reconciling;
  const activeModule = state.modules.find(module => module.id === state.activeModuleId) ?? null;
  const degraded = state.modules.filter(module => module.status === 'degraded');
  // Delete and Retry act on the saved module, so they only exist while one is open.
  const editingModule = editingId ? state.modules.find(module => module.id === editingId) ?? null : null;

  /** Categories owned by some OTHER module — what the server would 409 on. */
  const claimedElsewhere = useMemo(() => {
    const owners = new Map<string, string>();
    for (const module of state.modules) {
      if (module.id === editingId) continue;
      for (const game of module.games) owners.set(game.id, module.name);
    }
    return owners;
  }, [state.modules, editingId]);

  /** A group owned by another module cannot be claimed twice either. */
  const groupOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const module of state.modules) {
      if (module.id === editingId) continue;
      for (const group of module.rewardGroups) owners.set(group.id, module.name);
    }
    return owners;
  }, [state.modules, editingId]);

  const startCreate = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
    setMessage(null);
    setError(null);
  };

  const startEdit = (module: CategoryModule) => {
    setEditingId(module.id);
    setDraft(moduleToInput(module));
    setMessage(null);
    setError(null);
  };

  const closeEditor = () => {
    setEditingId(null);
    setDraft(null);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    setMessage(null);
    setError(null);

    const request = editingId ? updateCategoryModule(editingId, draft) : createCategoryModule(draft);
    void request
      .then(async saved => {
        await load();
        // Stay on the saved module: the editor is the right pane now, and after a create
        // a second Save would otherwise make a duplicate rather than update this one.
        setEditingId(saved.id);
        setDraft(moduleToInput(saved));
        setMessage('Module saved');
      })
      // A 409 arrives as a plain sentence from the server ("X is already claimed by
      // another category module."), so show it as-is.
      .catch(caught => setError(errorMessage(caught, 'Could not save the module')))
      .finally(() => setSaving(false));
  };

  const handleDelete = (module: CategoryModule) => {
    if (!window.confirm(`Delete "${module.name}"? Its triggers stop being module-scoped.`)) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    void deleteCategoryModule(module.id)
      .then(() => load())
      .then(() => {
        if (editingId === module.id) closeEditor();
        setMessage('Module deleted');
      })
      .catch(caught => setError(errorMessage(caught, 'Could not delete the module')))
      .finally(() => setSaving(false));
  };

  const handleReconcile = () => {
    setReconciling(true);
    setMessage(null);
    setError(null);
    void reconcileCategoryModules()
      .then(next => {
        setState(next);
        const stillDegraded = next.modules.some(module => module.status === 'degraded');
        setMessage(stillDegraded ? 'Reconciled, but a module is still degraded.' : 'Reconciled with Twitch.');
      })
      .catch(caught => setError(errorMessage(caught, 'Could not reconcile with Twitch')))
      .finally(() => setReconciling(false));
  };

  const toggleGroup = (groupId: string) => {
    setDraft(current => {
      if (!current) return current;
      const has = current.rewardGroupIds.includes(groupId);
      return {
        ...current,
        rewardGroupIds: has
          ? current.rewardGroupIds.filter(id => id !== groupId)
          : [...current.rewardGroupIds, groupId],
      };
    });
  };

  return (
    <>
        <SettingsHeader section="modules" />

        <SettingsStatus message={message} error={error} />

        <div className="set-group">
          <div className="set-group-label">Live state</div>
          <div className="settings-editor-section">
            <div className="module-live">
              <div>
                <div className="set-label">
                  {activeModule ? activeModule.name : 'No module active'}
                </div>
                <div className="set-sub">
                  {state.activeGameName
                    ? `Streaming ${state.activeGameName}.`
                    : 'No Twitch category established.'}{' '}
                  {activeModule
                    ? 'Its reward groups are on and its module-scoped triggers are armed.'
                    : 'Only global triggers are armed.'}
                  {state.lastReconciledAt && ` Last reconciled ${new Date(state.lastReconciledAt).toLocaleTimeString()}`}
                  {state.lastSignalSource && ` (${state.lastSignalSource}).`}
                </div>
              </div>
              <button className="modbtn" type="button" disabled={busy} onClick={handleReconcile}>
                {reconciling ? 'Reconciling...' : 'Reconcile now'}
              </button>
            </div>

            {/* A failed category lookup with no module active has nowhere per-module to
                report itself, and "no module active" from a healthy off-category stream
                must not look identical to "we could not reach Twitch". */}
            {state.lookupError && (
              <SettingsStatus
                error={<>
                  Could not establish the live Twitch category, so no reward state was changed:{' '}
                  {state.lookupError} Modules stay as they were until a Reconcile succeeds.
                </>}
              />
            )}

            {degraded.length > 0 && (
              <SettingsStatus
                error={<>
                  {degraded.length} module{degraded.length === 1 ? '' : 's'} degraded. Twitch did not fully accept the
                  last reward change — retry to re-apply it.
                </>}
              />
            )}
          </div>
        </div>

        <div className="set-group">
          <div className="set-group-label">Modules</div>

          <div className="settings-split">
            <div className="settings-split-list">
              <div className="split-list-head">
                <div className="set-sub">Pick a module to edit which categories and reward groups it owns.</div>
                <button className="modbtn gold" type="button" disabled={busy} onClick={startCreate}>New</button>
              </div>

              <div className="settings-mini-list">
                {loading ? (
                  <div className="command-empty">Loading modules...</div>
                ) : state.modules.length === 0 ? (
                  <div className="command-empty">No category modules yet.</div>
                ) : state.modules.map(module => (
                  <button
                    type="button"
                    key={module.id}
                    className={'settings-item-row'
                      + (module.status === 'degraded' ? ' settings-item-row--degraded' : '')
                      + (editingId === module.id ? ' is-selected' : '')}
                    aria-current={editingId === module.id ? 'true' : undefined}
                    onClick={() => startEdit(module)}
                  >
                    <div className="settings-item-main">
                      <b>{module.name}</b>
                      <StatusBadge module={module} active={module.id === state.activeModuleId} />
                      <span>
                        {module.games.length > 0 ? module.games.map(game => game.name).join(', ') : 'no categories claimed'}
                        {' \u00b7 '}
                        {module.rewardGroups.length > 0
                          ? `owns ${module.rewardGroups.map(group => group.name).join(', ')}`
                          : 'owns no reward groups'}
                      </span>
                      <div className="set-sub">{STATUS_HINTS[module.status]}</div>
                      {module.status === 'degraded' && module.statusDetail && (
                        <div className="module-status-detail">{module.statusDetail}</div>
                      )}
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
                    Pick a module on the left to edit the Twitch categories it claims and the reward
                    groups it switches. New adds one.
                  </div>
                </div>
              ) : (
            <form className="settings-editor-section" onSubmit={handleSubmit}>
              <div className="command-editor-head">
                <div>
                  <div className="set-label">{draft.name || 'Untitled module'}</div>
                  <div className="set-sub">A disabled module never activates, whatever category is live.</div>
                </div>
                <div className="command-row-actions">
                  {editingModule && editingModule.status === 'degraded' && (
                    <button className="modbtn gold" type="button" disabled={busy} onClick={handleReconcile}>
                      {reconciling ? 'Retrying...' : 'Retry'}
                    </button>
                  )}
                  {editingModule && (
                    <button className="modbtn danger" type="button" disabled={busy} onClick={() => handleDelete(editingModule)}>
                      Delete
                    </button>
                  )}
                  <button className="modbtn" type="button" disabled={saving} onClick={closeEditor}>Close</button>
                </div>
              </div>

              <div className="settings-mini-form">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={draft.name}
                    disabled={busy}
                    maxLength={60}
                    placeholder="Minecraft"
                    onChange={event => setDraft(current => (current ? { ...current, name: event.target.value } : current))}
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

                <GamePicker
                  games={draft.games}
                  claimedElsewhere={claimedElsewhere}
                  disabled={busy}
                  onChange={games => setDraft(current => (current ? { ...current, games } : current))}
                />

                <div className="field settings-wide-field">
                  <span>Reward groups this module owns</span>
                  <div className="module-group-list">
                    {groups.length === 0 ? (
                      <div className="command-empty">
                        No reward groups. Create them in Viewer rewards, then claim them here.
                      </div>
                    ) : groups.map(group => {
                      const owner = groupOwners.get(group.id);
                      return (
                        <label className={'module-group' + (owner ? ' module-group--conflict' : '')} key={group.id}>
                          <input
                            type="checkbox"
                            checked={draft.rewardGroupIds.includes(group.id)}
                            disabled={busy}
                            onChange={() => toggleGroup(group.id)}
                          />
                          <span>{group.name}</span>
                          <span className="media-asset-tag">{group.rewardCount} rewards</span>
                          {owner && <span className="media-asset-tag media-asset-tag--broken">owned by {owner}</span>}
                        </label>
                      );
                    })}
                  </div>
                  <small className="action-hint">
                    A module-owned group is switched on and off by the module, so it can no longer be toggled by hand
                    in Viewer rewards.
                  </small>
                </div>
              </div>

              <div className="command-settings-actions">
                <button className="modbtn gold" type="submit" disabled={busy || !draft.name.trim()}>
                  {saving ? 'Saving...' : 'Save module'}
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
