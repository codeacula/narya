import React, { useEffect, useMemo, useState } from 'react';
import type { MediaFile, MediaKind, RewardStreamCategory, SavedStreamCategory, SavedStreamCategoryInput, TwitchCategorySuggestion, ViewerReward, ViewerRewardCategory, ViewerRewardsResponse, ViewerRewardUpsert } from '../../shared/api';
import {
  addSavedStreamCategory,
  applyViewerRewardCategoryColor,
  createViewerReward,
  getCategorySuggestions,
  getSavedStreamCategories,
  setSavedStreamCategoryHidden,
  createViewerRewardCategory,
  deleteViewerReward,
  deleteViewerRewardCategory,
  getViewerRewards,
  updateViewerReward,
  updateViewerRewardCategory,
} from '../services/dashboard';
import { useSocket } from '../realtime';
import { formatBoxArtUrl, useDebouncedSuggestions } from '../suggestions';
import { SUGGESTION_DISMISS_MS } from '../../shared/constants';
import { SettingsHeader } from './settings/shared';

const EMPTY_REWARD: ViewerRewardUpsert = {
  title: '',
  prompt: '',
  cost: 100,
  isEnabled: true,
  isPaused: false,
  categoryId: null,
  isUserInputRequired: false,
  skipQueue: false,
  backgroundColor: '#9147FF',
  globalCooldown: { enabled: false, seconds: 60 },
  maxPerStream: { enabled: false, max: 1 },
  maxPerUserPerStream: { enabled: false, max: 1 },
};

const DEFAULT_MEDIA_VOLUME = 0.8;

const COOLDOWN_UNITS = [
  { id: 'seconds', label: 'seconds', mult: 1 },
  { id: 'minutes', label: 'minutes', mult: 60 },
  { id: 'hours', label: 'hours', mult: 3600 },
] as const;
type CooldownUnit = typeof COOLDOWN_UNITS[number]['id'];

// Show a cooldown in the largest unit that divides evenly, so 300s reads as "5 minutes" not "300 seconds".
function splitCooldown(seconds: number): { value: number; unit: CooldownUnit } {
  const total = Math.max(1, Math.round(seconds || 0));
  if (total % 3600 === 0) return { value: total / 3600, unit: 'hours' };
  if (total % 60 === 0) return { value: total / 60, unit: 'minutes' };
  return { value: total, unit: 'seconds' };
}

function cooldownToSeconds(value: number, unit: CooldownUnit): number {
  const mult = COOLDOWN_UNITS.find(entry => entry.id === unit)?.mult ?? 1;
  return Math.max(1, Math.round(value || 1)) * mult;
}

function formatCooldown(seconds: number): string {
  const { value, unit } = splitCooldown(seconds);
  return `${value}${unit === 'seconds' ? 's' : unit === 'minutes' ? 'm' : 'h'}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formFromReward(reward: ViewerReward): ViewerRewardUpsert {
  return {
    title: reward.title,
    prompt: reward.prompt,
    cost: reward.cost,
    isEnabled: reward.isEnabled,
    isPaused: reward.isPaused,
    categoryId: reward.categoryId,
    isUserInputRequired: reward.isUserInputRequired,
    skipQueue: reward.skipQueue,
    backgroundColor: reward.backgroundColor,
    // Twitch reports 0s for a never-set cooldown; seed a sane value so the picker isn't stuck at "0".
    globalCooldown: reward.globalCooldown.seconds > 0 ? reward.globalCooldown : { ...reward.globalCooldown, seconds: 60 },
    maxPerStream: reward.maxPerStream,
    maxPerUserPerStream: reward.maxPerUserPerStream,
  };
}

function SwitchRow({
  label,
  hint,
  badge,
  checked,
  disabled,
  onToggle,
  children,
}: {
  label: string;
  hint?: string;
  badge?: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={'reward-ctrl' + (checked ? ' active' : '')}>
      <label className="reward-switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onToggle(event.target.checked)} />
        <span className="reward-switch-track" aria-hidden="true" />
        <span className="reward-ctrl-label">
          <b>{label}{badge ? <span className="reward-new">{badge}</span> : null}</b>
          {hint ? <small>{hint}</small> : null}
        </span>
      </label>
      {children ? <div className="reward-ctrl-value">{children}</div> : null}
    </div>
  );
}

function RewardEditor({
  categories,
  form,
  editing,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  categories: ViewerRewardCategory[];
  form: ViewerRewardUpsert;
  editing: boolean;
  busy: boolean;
  onChange: React.Dispatch<React.SetStateAction<ViewerRewardUpsert>>;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const initialCooldown = splitCooldown(form.globalCooldown.seconds);
  const [cooldownValue, setCooldownValue] = useState(initialCooldown.value);
  const [cooldownUnit, setCooldownUnit] = useState<CooldownUnit>(initialCooldown.unit);

  const applyCooldown = (value: number, unit: CooldownUnit) => {
    setCooldownValue(value);
    setCooldownUnit(unit);
    onChange(current => ({ ...current, globalCooldown: { ...current.globalCooldown, seconds: cooldownToSeconds(value, unit) } }));
  };
  // The bound file was deleted from public/. Say so rather than letting the
  // select silently display some other file as if it were the binding.

  // Switching kind picks the first file of that kind, so the form never holds a
  // binding whose src doesn't match its kind (the server would reject it).

  return (
    <form className="reward-editor" onSubmit={onSubmit}>
      <div className="reward-editor-head">
        <div>
          <div className="set-label">{editing ? 'Edit reward' : 'New reward'}</div>
          <div className="set-sub">Rewards created here can be edited, grouped, toggled, and removed later.</div>
        </div>
        <button className="modbtn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>

      <fieldset className="reward-fieldset">
        <legend className="reward-legend">Basics</legend>
        <div className="reward-form-grid">
          <label className="field reward-form-title">
            <span>Title</span>
            <input
              autoFocus
              required
              maxLength={45}
              disabled={busy}
              value={form.title}
              onChange={event => onChange(current => ({ ...current, title: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Point cost</span>
            <input
              required
              min={1}
              step={1}
              type="number"
              disabled={busy}
              value={form.cost}
              onChange={event => onChange(current => ({ ...current, cost: Number(event.target.value) }))}
            />
          </label>
          <label className="field reward-form-prompt">
            <span>Description</span>
            <textarea
              maxLength={200}
              rows={3}
              disabled={busy}
              value={form.prompt}
              placeholder="Optional instructions shown to viewers"
              onChange={event => onChange(current => ({ ...current, prompt: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Category</span>
            <select
              disabled={busy}
              value={form.categoryId ?? ''}
              onChange={event => onChange(current => ({ ...current, categoryId: event.target.value || null }))}
            >
              <option value="">Uncategorized</option>
              {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Orb color</span>
            <input
              type="color"
              disabled={busy}
              value={form.backgroundColor}
              onChange={event => onChange(current => ({ ...current, backgroundColor: event.target.value }))}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="reward-fieldset">
        <legend className="reward-legend">On redeem</legend>
        <div className="set-sub">
          What a redeem does — play a clip or sound, speak with TTS, show overlay text, run several
          of those together — is an <strong>action</strong> now, fired by a channel-point reward
          trigger. Set it up in <code>Settings → Automation triggers → Channel point reward</code>.
          Your existing media and TTS bindings were migrated there automatically.
        </div>
      </fieldset>

      <fieldset className="reward-fieldset">
        <legend className="reward-legend">Availability</legend>
        <SwitchRow
          label="Enabled on Twitch"
          hint="Viewers can see and redeem it now."
          checked={form.isEnabled}
          disabled={busy}
          onToggle={next => onChange(current => ({ ...current, isEnabled: next }))}
        />
        <SwitchRow
          label="Paused"
          badge="new"
          hint="Stays visible but rejects redemptions until you resume."
          checked={form.isPaused}
          disabled={busy}
          onToggle={next => onChange(current => ({ ...current, isPaused: next }))}
        />
        <SwitchRow
          label="Skip the request queue"
          badge="new"
          hint="Mark redemptions fulfilled instantly — no manual approval."
          checked={form.skipQueue}
          disabled={busy}
          onToggle={next => onChange(current => ({ ...current, skipQueue: next }))}
        />
        <SwitchRow
          label="Viewers must enter text"
          hint="Collect a message with each redeem — required to route it to TTS."
          checked={form.isUserInputRequired}
          disabled={busy}
          onToggle={next => onChange(current => ({ ...current, isUserInputRequired: next }))}
        />
      </fieldset>

      <fieldset className="reward-fieldset">
        <legend className="reward-legend">Limits &amp; cooldown</legend>
        <SwitchRow
          label="Max per stream"
          hint="Total redemptions allowed each broadcast."
          checked={form.maxPerStream.enabled}
          disabled={busy}
          onToggle={next => onChange(current => ({ ...current, maxPerStream: { ...current.maxPerStream, enabled: next } }))}
        >
          <input
            type="number"
            min={1}
            step={1}
            aria-label="Max redemptions per stream"
            disabled={busy || !form.maxPerStream.enabled}
            value={form.maxPerStream.max}
            onChange={event => onChange(current => ({ ...current, maxPerStream: { ...current.maxPerStream, max: Number(event.target.value) } }))}
          />
        </SwitchRow>
        <SwitchRow
          label="Max per user each stream"
          hint="Keeps one viewer from taking them all."
          checked={form.maxPerUserPerStream.enabled}
          disabled={busy}
          onToggle={next => onChange(current => ({ ...current, maxPerUserPerStream: { ...current.maxPerUserPerStream, enabled: next } }))}
        >
          <input
            type="number"
            min={1}
            step={1}
            aria-label="Max redemptions per user each stream"
            disabled={busy || !form.maxPerUserPerStream.enabled}
            value={form.maxPerUserPerStream.max}
            onChange={event => onChange(current => ({ ...current, maxPerUserPerStream: { ...current.maxPerUserPerStream, max: Number(event.target.value) } }))}
          />
        </SwitchRow>
        <SwitchRow
          label="Global cooldown"
          badge="new"
          hint="Lock the reward briefly after each redeem."
          checked={form.globalCooldown.enabled}
          disabled={busy}
          onToggle={next => onChange(current => ({ ...current, globalCooldown: { ...current.globalCooldown, enabled: next } }))}
        >
          <input
            type="number"
            min={1}
            step={1}
            aria-label="Cooldown length"
            disabled={busy || !form.globalCooldown.enabled}
            value={cooldownValue}
            onChange={event => applyCooldown(Number(event.target.value), cooldownUnit)}
          />
          <select
            aria-label="Cooldown unit"
            disabled={busy || !form.globalCooldown.enabled}
            value={cooldownUnit}
            onChange={event => applyCooldown(cooldownValue, event.target.value as CooldownUnit)}
          >
            {COOLDOWN_UNITS.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
          </select>
        </SwitchRow>
      </fieldset>

      <div className="command-settings-actions">
        <button className="modbtn gold" type="submit" disabled={busy}>
          {busy ? 'Saving...' : editing ? 'Save reward' : 'Create reward'}
        </button>
      </div>
    </form>
  );
}

function RewardRow({
  reward,
  categories,
  busy,
  onEdit,
  onDelete,
  onCategoryChange,
  onPauseToggle,
}: {
  reward: ViewerReward;
  categories: ViewerRewardCategory[];
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCategoryChange: (categoryId: string | null) => void;
  onPauseToggle: () => void;
}) {
  const dimmed = !reward.isEnabled || reward.isPaused;
  return (
    <div className={'reward-row' + (dimmed ? ' disabled' : '')}>
      <div className="reward-orb" style={{ ['--reward-color' as string]: reward.backgroundColor }}>
        {reward.imageUrl ? <img src={reward.imageUrl} alt="" /> : null}
      </div>
      <div className="reward-main">
        <div className="reward-title-line">
          <b>{reward.title}</b>
          <span className={reward.isEnabled ? 'reward-state on' : 'reward-state'}>{reward.isEnabled ? 'On' : 'Off'}</span>
          {reward.isPaused ? <span className="reward-state paused">Paused</span> : null}
          {reward.skipQueue ? <span className="reward-state auto">Auto</span> : null}
          {!reward.canManage ? <span className="reward-state readonly">Twitch-managed</span> : null}
        </div>
        <div className="reward-meta">
          <span className="reward-meta-cost">{reward.cost.toLocaleString()} pts</span>
          {reward.globalCooldown.enabled ? <span>{formatCooldown(reward.globalCooldown.seconds)} cooldown</span> : null}
          {reward.maxPerStream.enabled ? <span>{reward.maxPerStream.max} / stream</span> : null}
          {reward.maxPerUserPerStream.enabled ? <span>{reward.maxPerUserPerStream.max} / user</span> : null}
          {reward.isUserInputRequired ? <span>text required</span> : null}
          {reward.prompt ? <span className="reward-meta-prompt">{reward.prompt}</span> : null}
        </div>
      </div>
      <label className="reward-category-select">
        <span className="sr-only">Category for {reward.title}</span>
        <select
          value={reward.categoryId ?? ''}
          disabled={busy}
          onChange={event => onCategoryChange(event.target.value || null)}
        >
          <option value="">Uncategorized</option>
          {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </label>
      <div className="reward-actions">
        {reward.canManage && (
          <button
            className={'modbtn' + (reward.isPaused ? ' gold' : '')}
            type="button"
            disabled={busy}
            title={reward.isPaused ? 'Resume redemptions' : 'Pause redemptions'}
            onClick={onPauseToggle}
          >
            {reward.isPaused ? 'Resume' : 'Pause'}
          </button>
        )}
        <button className="modbtn" type="button" disabled={busy || !reward.canManage} onClick={onEdit}>Edit</button>
        <button className="modbtn danger" type="button" disabled={busy || !reward.canManage} onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

// One box-art row inside the combo dropdown: a clickable art+name pick plus a trailing control
// (a status tag for search hits, or a hide/unhide button for saved entries).
function SavedCategoryRow({
  name,
  boxArtUrl,
  disabled,
  className,
  keepFocus,
  onPick,
  trailing,
}: {
  name: string;
  boxArtUrl: string | null;
  disabled: boolean;
  className?: string;
  keepFocus: (event: React.MouseEvent) => void;
  onPick: () => void;
  trailing?: React.ReactNode;
}) {
  const art = formatBoxArtUrl(boxArtUrl, 36, 48);
  return (
    <div className={'suggestion-item' + (className ? ' ' + className : '')}>
      <button type="button" className="suggestion-pick" disabled={disabled} onMouseDown={keepFocus} onClick={onPick}>
        {art ? <img className="suggestion-art" src={art} alt="" /> : <span className="suggestion-art placeholder" />}
        <span className="suggestion-name">{name}</span>
      </button>
      {trailing}
    </div>
  );
}

function CategoryGamesEditor({
  category,
  busy,
  saved,
  onAssign,
  onAddAndAssign,
  onSetHidden,
}: {
  category: ViewerRewardCategory;
  busy: boolean;
  saved: SavedStreamCategory[];
  onAssign: (games: RewardStreamCategory[]) => void;
  onAddAndAssign: (game: SavedStreamCategoryInput) => void;
  onSetHidden: (id: string, hidden: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const { suggestions } = useDebouncedSuggestions(query, getCategorySuggestions);

  const assignedIds = new Set(category.games.map(game => game.id));
  const savedIds = new Set(saved.map(cat => cat.id));
  const searching = query.trim().length >= 2;
  const visibleSaved = saved.filter(cat => !cat.hidden && !assignedIds.has(cat.id));
  const hiddenSaved = saved.filter(cat => cat.hidden && !assignedIds.has(cat.id));

  const close = () => { setOpen(false); setQuery(''); setShowHidden(false); };
  const removeGame = (id: string) => onAssign(category.games.filter(game => game.id !== id));
  const assignSaved = (cat: SavedStreamCategory) => { onAssign([...category.games, { id: cat.id, name: cat.name }]); close(); };
  // Always route through the parent: it saves the category, then assigns it only if not already mapped.
  const addFromSearch = (suggestion: TwitchCategorySuggestion) => {
    onAddAndAssign({ id: suggestion.id, name: suggestion.name, boxArtUrl: suggestion.boxArtUrl });
    close();
  };
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className="reward-games">
      <div className="reward-games-head">
        <span className="reward-games-label">Active for stream categories</span>
        <span className="reward-games-hint">On when you stream one of these; off when you switch away. Leave empty to control this group by hand.</span>
      </div>
      <div className="reward-games-row">
        {category.games.map(game => (
          <span className="reward-game-chip" key={game.id}>
            {game.name}
            <button type="button" aria-label={`Remove ${game.name}`} disabled={busy} onClick={() => removeGame(game.id)}>×</button>
          </span>
        ))}
        <div className="reward-games-add">
          <button
            type="button"
            className="reward-games-addbtn"
            disabled={busy}
            aria-expanded={open}
            onClick={() => (open ? close() : setOpen(true))}
          >
            + Add
          </button>
          {open && (
            <div className="reward-combo">
              <input
                className="reward-combo-search"
                type="text"
                autoFocus
                disabled={busy}
                value={query}
                placeholder="Search to add a new one…"
                onBlur={() => window.setTimeout(close, SUGGESTION_DISMISS_MS)}
                onChange={event => setQuery(event.target.value)}
              />
              <div className="reward-combo-list" onMouseDown={keepFocus}>
                {searching ? (
                  suggestions.length === 0 ? (
                    <div className="suggestion-empty">No matches yet…</div>
                  ) : suggestions.map(suggestion => (
                    <SavedCategoryRow
                      key={suggestion.id}
                      name={suggestion.name}
                      boxArtUrl={suggestion.boxArtUrl}
                      disabled={busy}
                      keepFocus={keepFocus}
                      onPick={() => addFromSearch(suggestion)}
                      trailing={assignedIds.has(suggestion.id) ? <span className="suggestion-tag">added</span>
                        : savedIds.has(suggestion.id) ? <span className="suggestion-tag">saved</span> : null}
                    />
                  ))
                ) : (
                  <>
                    {visibleSaved.length === 0 ? (
                      <div className="suggestion-empty">No saved categories yet — search above to add one.</div>
                    ) : visibleSaved.map(cat => (
                      <SavedCategoryRow
                        key={cat.id}
                        name={cat.name}
                        boxArtUrl={cat.boxArtUrl}
                        disabled={busy}
                        keepFocus={keepFocus}
                        onPick={() => assignSaved(cat)}
                        trailing={<button type="button" className="suggestion-hide" title="Hide from saved categories" disabled={busy} onMouseDown={keepFocus} onClick={() => onSetHidden(cat.id, true)}>Hide</button>}
                      />
                    ))}
                    {hiddenSaved.length > 0 && (
                      <button type="button" className="suggestion-toggle" disabled={busy} onMouseDown={keepFocus} onClick={() => setShowHidden(value => !value)}>
                        {showHidden ? 'Hide hidden' : `Show hidden (${hiddenSaved.length})`}
                      </button>
                    )}
                    {showHidden && hiddenSaved.map(cat => (
                      <SavedCategoryRow
                        key={cat.id}
                        className="is-hidden"
                        name={cat.name}
                        boxArtUrl={cat.boxArtUrl}
                        disabled={busy}
                        keepFocus={keepFocus}
                        onPick={() => assignSaved(cat)}
                        trailing={<button type="button" className="suggestion-hide" title="Show in this list again" disabled={busy} onMouseDown={keepFocus} onClick={() => onSetHidden(cat.id, false)}>Unhide</button>}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ViewerRewardsPage() {
  const [data, setData] = useState<ViewerRewardsResponse>({ categories: [], rewards: [] });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rewardForm, setRewardForm] = useState<ViewerRewardUpsert>(EMPTY_REWARD);
  const [savedCategories, setSavedCategories] = useState<SavedStreamCategory[]>([]);

  const groupedRewards = useMemo(() => {
    const groups = new Map<string | null, ViewerReward[]>();
    for (const reward of data.rewards) {
      const current = groups.get(reward.categoryId) ?? [];
      current.push(reward);
      groups.set(reward.categoryId, current);
    }
    for (const rewards of groups.values()) rewards.sort((a, b) => a.title.localeCompare(b.title));
    return groups;
  }, [data.rewards]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rewards, savedCats] = await Promise.all([getViewerRewards(), getSavedStreamCategories()]);
      setData(rewards);
      setSavedCategories(savedCats);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load viewer rewards.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);


  // A stream-category change can auto-toggle reward groups server-side; refetch silently so the list reflects it.
  useSocket<{ at: string }>('rewards:updated', React.useCallback(() => {
    void getViewerRewards().then(setData).catch(() => undefined);
  }, []));


  // Only offered while editing a saved reward — a reward being created has no id

  const handlePauseToggle = async (reward: ViewerReward) => {
    setBusyId(reward.id);
    setError(null);
    setMessage(null);
    try {
      setData(await updateViewerReward(reward.id, { isPaused: !reward.isPaused }));
      setMessage(reward.isPaused ? `"${reward.title}" resumed.` : `"${reward.title}" paused.`);
    } catch (pauseError) {
      setError(errorMessage(pauseError, 'Could not update the reward pause state.'));
    } finally {
      setBusyId(null);
    }
  };

  const startCreate = (categoryId: string | null = null) => {
    const category = categoryId ? data.categories.find(c => c.id === categoryId) : null;
    const backgroundColor = category?.defaultBackgroundColor ?? EMPTY_REWARD.backgroundColor;
    setRewardForm({ ...EMPTY_REWARD, categoryId, backgroundColor });
    setEditingId(null);
    setShowEditor(true);
    setError(null);
    setMessage(null);
  };

  const startEdit = (reward: ViewerReward) => {
    setRewardForm(formFromReward(reward));
    setEditingId(reward.id);
    setShowEditor(true);
    setError(null);
    setMessage(null);
  };

  const handleRewardSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusyId(editingId ?? 'create-reward');
    setError(null);
    setMessage(null);
    try {
      const next = editingId
        ? await updateViewerReward(editingId, rewardForm)
        : await createViewerReward(rewardForm);
      setData(next);
      setShowEditor(false);
      setEditingId(null);
      setRewardForm(EMPTY_REWARD);
      setMessage(editingId ? 'Reward updated on Twitch.' : 'Reward created on Twitch.');
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save reward.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleRewardDelete = async (reward: ViewerReward) => {
    if (!window.confirm(`Delete "${reward.title}" from Twitch? This cannot be undone.`)) return;
    setBusyId(reward.id);
    setError(null);
    setMessage(null);
    try {
      await deleteViewerReward(reward.id);
      setData(current => ({ ...current, rewards: current.rewards.filter(item => item.id !== reward.id) }));
      setMessage('Reward deleted from Twitch.');
    } catch (deleteError) {
      setError(errorMessage(deleteError, 'Could not delete reward.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleCategoryAssignment = async (reward: ViewerReward, categoryId: string | null) => {
    setBusyId(reward.id);
    setError(null);
    setMessage(null);
    try {
      setData(await updateViewerReward(reward.id, { categoryId }));
      setMessage('Reward category updated.');
    } catch (updateError) {
      setError(errorMessage(updateError, 'Could not update reward category.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleCategoryGames = async (
    category: ViewerRewardCategory,
    games: RewardStreamCategory[],
    failureMessage = 'Could not update stream categories.',
  ) => {
    setBusyId(category.id + '-games');
    setError(null);
    setMessage(null);
    try {
      setData(await updateViewerRewardCategory(category.id, { games }));
    } catch (updateError) {
      setError(errorMessage(updateError, failureMessage));
    } finally {
      setBusyId(null);
    }
  };

  const handleAddAndAssign = async (category: ViewerRewardCategory, game: SavedStreamCategoryInput) => {
    setBusyId(category.id + '-games');
    setError(null);
    setMessage(null);
    try {
      setSavedCategories(await addSavedStreamCategory(game));
    } catch (addError) {
      setError(errorMessage(addError, 'Could not add that stream category.'));
      setBusyId(null);
      return;
    }
    // Save always succeeds first; only assign to the group when the game isn't already mapped there.
    if (category.games.some(existing => existing.id === game.id)) {
      setBusyId(null);
      return;
    }
    await handleCategoryGames(
      category,
      [...category.games, { id: game.id, name: game.name }],
      "Saved the category, but couldn't assign it to this group.",
    );
  };

  const handleSetCategoryHidden = async (id: string, hidden: boolean) => {
    setError(null);
    try {
      setSavedCategories(await setSavedStreamCategoryHidden(id, hidden));
    } catch (hideError) {
      setError(errorMessage(hideError, 'Could not update the saved category.'));
    }
  };

  const handleCategoryCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusyId('create-category');
    setError(null);
    setMessage(null);
    try {
      const category = await createViewerRewardCategory(categoryName);
      setData(current => ({ ...current, categories: [...current.categories, category].sort((a, b) => a.name.localeCompare(b.name)) }));
      setCategoryName('');
      setMessage('Category created.');
    } catch (createError) {
      setError(errorMessage(createError, 'Could not create category.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleCategoryToggle = async (category: ViewerRewardCategory) => {
    setBusyId(category.id);
    setError(null);
    setMessage(null);
    try {
      const next = await updateViewerRewardCategory(category.id, { enabled: !category.enabled });
      setData(next);
      const skipped = next.skippedReadOnlyCount > 0
        ? ` ${next.skippedReadOnlyCount} Twitch-managed reward${next.skippedReadOnlyCount === 1 ? ' was' : 's were'} left unchanged.`
        : '';
      setMessage(`${category.name} turned ${category.enabled ? 'off' : 'on'}; ${next.updatedCount} reward${next.updatedCount === 1 ? '' : 's'} updated.${skipped}`);
    } catch (toggleError) {
      setError(errorMessage(toggleError, 'Could not toggle category.'));
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleCategoryDelete = async (category: ViewerRewardCategory) => {
    if (!window.confirm(`Delete the "${category.name}" category? Its rewards will become uncategorized.`)) return;
    setBusyId(category.id);
    setError(null);
    setMessage(null);
    try {
      await deleteViewerRewardCategory(category.id);
      setData(current => ({
        categories: current.categories.filter(item => item.id !== category.id),
        rewards: current.rewards.map(reward => reward.categoryId === category.id ? { ...reward, categoryId: null } : reward),
      }));
      setMessage('Category deleted; its rewards are now uncategorized.');
    } catch (deleteError) {
      setError(errorMessage(deleteError, 'Could not delete category.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleCategoryColorChange = async (category: ViewerRewardCategory, color: string) => {
    setBusyId(category.id + '-color');
    setError(null);
    setMessage(null);
    try {
      const next = await updateViewerRewardCategory(category.id, { defaultBackgroundColor: color });
      setData(next);
    } catch (updateError) {
      setError(errorMessage(updateError, 'Could not update category color.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleApplyCategoryColor = async (category: ViewerRewardCategory) => {
    setBusyId(category.id + '-apply');
    setError(null);
    setMessage(null);
    try {
      setData(await applyViewerRewardCategoryColor(category.id));
      setMessage(`Color applied to all manageable rewards in "${category.name}".`);
    } catch (applyError) {
      setError(errorMessage(applyError, 'Could not apply category color.'));
    } finally {
      setBusyId(null);
    }
  };

  const renderGroup = (category: ViewerRewardCategory | null) => {
    const categoryId = category?.id ?? null;
    const rewards = groupedRewards.get(categoryId) ?? [];
    if (!category && rewards.length === 0) return null;
    return (
      <section className="reward-group" key={categoryId ?? 'uncategorized'}>
        <div className="reward-group-head">
          <div>
            <h3>{category?.name ?? 'Uncategorized'}</h3>
            <span>{rewards.length} reward{rewards.length === 1 ? '' : 's'}</span>
          </div>
          <div className="reward-group-actions">
            {category ? (
              <>
                <label className="reward-toggle">
                  <input
                    type="checkbox"
                    checked={category.enabled}
                    disabled={Boolean(busyId)}
                    onChange={() => void handleCategoryToggle(category)}
                  />
                  <span>{category.enabled ? 'Enabled' : 'Disabled'}</span>
                </label>
                <label className="reward-category-color" title="Default color for this category">
                  <span className="sr-only">Default color</span>
                  <input
                    type="color"
                    value={category.defaultBackgroundColor ?? '#9147FF'}
                    disabled={Boolean(busyId)}
                    onChange={event => void handleCategoryColorChange(category, event.target.value)}
                  />
                </label>
                {category.defaultBackgroundColor ? (
                  <button className="modbtn" type="button" disabled={Boolean(busyId)} onClick={() => void handleApplyCategoryColor(category)}>Apply color to all</button>
                ) : null}
                <button className="modbtn danger" type="button" disabled={Boolean(busyId)} onClick={() => void handleCategoryDelete(category)}>Delete group</button>
              </>
            ) : null}
            <button className="modbtn" type="button" disabled={Boolean(busyId)} onClick={() => startCreate(categoryId)}>Add reward</button>
          </div>
        </div>
        {category ? (
          <CategoryGamesEditor
            category={category}
            busy={Boolean(busyId)}
            saved={savedCategories}
            onAssign={games => void handleCategoryGames(category, games)}
            onAddAndAssign={game => void handleAddAndAssign(category, game)}
            onSetHidden={(id, hidden) => void handleSetCategoryHidden(id, hidden)}
          />
        ) : null}
        <div className="reward-list">
          {rewards.length === 0 ? (
            <div className="reward-empty">No rewards in this category.</div>
          ) : rewards.map(reward => (
            <RewardRow
              key={reward.id}
              reward={reward}
              categories={data.categories}
              busy={Boolean(busyId)}
              onEdit={() => startEdit(reward)}
              onDelete={() => void handleRewardDelete(reward)}
              onCategoryChange={categoryId => void handleCategoryAssignment(reward, categoryId)}
              onPauseToggle={() => void handlePauseToggle(reward)}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="rewards-page">
        <SettingsHeader
          section="rewards"
          actions={<button className="btn-primary" type="button" disabled={loading || Boolean(busyId)} onClick={() => startCreate()}>New reward</button>}
        />

        {error ? <div className="set-status error">{error}</div> : null}
        {message ? <div className="set-status">{message}</div> : null}

        <div className="set-group reward-category-manager">
          <div className="set-group-label">Categories</div>
          <form className="reward-category-form" onSubmit={handleCategoryCreate}>
            <label className="field">
              <span>New category name</span>
              <input
                required
                maxLength={60}
                value={categoryName}
                disabled={Boolean(busyId)}
                placeholder="Game integration"
                onChange={event => setCategoryName(event.target.value)}
              />
            </label>
            <button className="modbtn gold" type="submit" disabled={Boolean(busyId)}>Add category</button>
          </form>
        </div>

        {showEditor ? (
          <div className="set-group">
            <RewardEditor
              categories={data.categories}
              form={rewardForm}
              editing={Boolean(editingId)}
              busy={Boolean(busyId)}
              onChange={setRewardForm}
              onCancel={() => { setShowEditor(false); setEditingId(null); }}
              onSubmit={handleRewardSubmit}
            />
          </div>
        ) : null}

        {loading ? (
          <div className="reward-loading">Loading rewards from Twitch...</div>
        ) : (
          <>
            {data.categories.map(category => renderGroup(category))}
            {renderGroup(null)}
            {data.categories.length === 0 && data.rewards.length === 0 ? (
              <div className="reward-empty-state">
                <h3>No viewer rewards yet</h3>
                <p>Create a category for an integration, then add its rewards.</p>
                <button className="btn-primary" type="button" onClick={() => startCreate()}>Create first reward</button>
              </div>
            ) : null}
          </>
        )}

        <p className="reward-api-note">Twitch only lets an app edit or delete rewards created by that same app. Rewards created in Twitch are still listed and can be categorized here, but remain read-only.</p>
    </div>
  );
}
