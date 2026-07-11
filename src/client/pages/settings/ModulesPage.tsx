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

const EMPTY_RESPONSE: CategoryModulesResponse = {
  modules: [],
  activeModuleId: null,
  activeGameId: null,
  activeGameName: null,
  lastSignalSource: null,
  lastReconciledAt: null,
};

const EMPTY_DRAFT: CategoryModuleInput = { name: '', enabled: true, games: [], rewardGroupIds: [] };

const STATUS_HINTS: Record<CategoryModuleStatus, string> = {
  idle: 'Not the active module. Its reward groups are off and its module-scoped triggers are disarmed.',
  active: 'The live Twitch category belongs to this module. Its reward groups are on.',
  degraded: 'The last reconciliation did not complete. The module kept its previous state — retry to re-apply it.',
};

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

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

export function ModulesSettingsPage({ onBack }: { onBack: () => void }) {
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
      .catch(caught => { if (!cancelled) setError(errorText(caught, 'Could not load category modules')); })
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
      .then(() => load())
      .then(() => {
        closeEditor();
        setMessage('Module saved');
      })
      // A 409 arrives as a plain sentence from the server ("X is already claimed by
      // another category module."), so show it as-is.
      .catch(caught => setError(errorText(caught, 'Could not save the module')))
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
      .catch(caught => setError(errorText(caught, 'Could not delete the module')))
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
      .catch(caught => setError(errorText(caught, 'Could not reconcile with Twitch')))
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
    <div className="settings-page">
      <div className="settings-inner">
        <div className="rewards-header">
          <div>
            <div className="settings-eyebrow">settings</div>
            <h2 className="settings-title">Category modules</h2>
            <p className="set-intro">
              A module owns Twitch categories and channel-point reward groups. Switching game deactivates one module
              and activates another, turning its reward groups on and the outgoing module's off.
            </p>
          </div>
          <div className="command-row-actions">
            <button className="modbtn" type="button" onClick={onBack}>Back</button>
            <button className="btn-primary" type="button" disabled={busy} onClick={startCreate}>New module</button>
          </div>
        </div>

        {(message || error) && (
          <div className={'command-settings-status' + (error ? ' error' : '')}>{error ?? message}</div>
        )}

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

            {degraded.length > 0 && (
              <div className="command-settings-status error">
                {degraded.length} module{degraded.length === 1 ? '' : 's'} degraded. Twitch did not fully accept the
                last reward change — retry to re-apply it.
              </div>
            )}
          </div>
        </div>

        {draft && (
          <div className="set-group">
            <div className="set-group-label">{editingId ? 'Edit module' : 'New module'}</div>

            <form className="settings-editor-section" onSubmit={handleSubmit}>
              <div className="command-editor-head">
                <div>
                  <div className="set-label">{draft.name || 'Untitled module'}</div>
                  <div className="set-sub">A disabled module never activates, whatever category is live.</div>
                </div>
                <button className="modbtn" type="button" disabled={saving} onClick={closeEditor}>Close</button>
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
          </div>
        )}

        <div className="set-group">
          <div className="set-group-label">Modules</div>

          <div className="settings-editor-section">
            <div className="settings-mini-list">
              {loading ? (
                <div className="command-empty">Loading modules...</div>
              ) : state.modules.length === 0 ? (
                <div className="command-empty">No category modules yet.</div>
              ) : state.modules.map(module => (
                <div
                  className={'settings-item-row' + (module.status === 'degraded' ? ' settings-item-row--degraded' : '')}
                  key={module.id}
                >
                  <div className="settings-item-main">
                    <b>{module.name}</b>
                    <StatusBadge module={module} active={module.id === state.activeModuleId} />
                    <span>
                      {module.games.length > 0 ? module.games.map(game => game.name).join(', ') : 'no categories claimed'}
                      {' · '}
                      {module.rewardGroups.length > 0
                        ? `owns ${module.rewardGroups.map(group => group.name).join(', ')}`
                        : 'owns no reward groups'}
                    </span>
                    <div className="set-sub">{STATUS_HINTS[module.status]}</div>
                    {module.status === 'degraded' && module.statusDetail && (
                      <div className="module-status-detail">{module.statusDetail}</div>
                    )}
                  </div>
                  <div className="command-row-actions">
                    {module.status === 'degraded' && (
                      <button className="modbtn gold" type="button" disabled={busy} onClick={handleReconcile}>
                        {reconciling ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                    <button className="modbtn" type="button" disabled={busy} onClick={() => startEdit(module)}>
                      Edit
                    </button>
                    <button className="modbtn danger" type="button" disabled={busy} onClick={() => handleDelete(module)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
