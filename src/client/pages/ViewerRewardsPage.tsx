import React, { useEffect, useMemo, useState } from 'react';
import type { ViewerReward, ViewerRewardCategory, ViewerRewardsResponse, ViewerRewardUpsert } from '../../shared/api';
import {
  applyViewerRewardCategoryColor,
  createViewerReward,
  createViewerRewardCategory,
  deleteViewerReward,
  deleteViewerRewardCategory,
  getTtsEnabledRewards,
  getViewerRewards,
  setTtsRewardEnabled,
  updateViewerReward,
  updateViewerRewardCategory,
} from '../services/dashboard';

const EMPTY_REWARD: ViewerRewardUpsert = {
  title: '',
  prompt: '',
  cost: 100,
  isEnabled: true,
  categoryId: null,
  isUserInputRequired: false,
  backgroundColor: '#9147FF',
  maxPerStream: { enabled: false, max: 1 },
  maxPerUserPerStream: { enabled: false, max: 1 },
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formFromReward(reward: ViewerReward): ViewerRewardUpsert {
  return {
    title: reward.title,
    prompt: reward.prompt,
    cost: reward.cost,
    isEnabled: reward.isEnabled,
    categoryId: reward.categoryId,
    isUserInputRequired: reward.isUserInputRequired,
    backgroundColor: reward.backgroundColor,
    maxPerStream: reward.maxPerStream,
    maxPerUserPerStream: reward.maxPerUserPerStream,
  };
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
  return (
    <form className="reward-editor" onSubmit={onSubmit}>
      <div className="reward-editor-head">
        <div>
          <div className="set-label">{editing ? 'Edit reward' : 'New reward'}</div>
          <div className="set-sub">Rewards created here can be edited, grouped, toggled, and removed later.</div>
        </div>
        <button className="modbtn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
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
          <span>Background color</span>
          <input
            type="color"
            disabled={busy}
            value={form.backgroundColor}
            onChange={event => onChange(current => ({ ...current, backgroundColor: event.target.value }))}
          />
        </label>
        <div className="field reward-form-limits">
          <span>Max per stream</span>
          <div className="reward-limit-row">
            <label className="command-enabled">
              <input
                type="checkbox"
                checked={form.maxPerStream.enabled}
                disabled={busy}
                onChange={event => onChange(current => ({ ...current, maxPerStream: { ...current.maxPerStream, enabled: event.target.checked } }))}
              />
              Enable
            </label>
            <input
              type="number"
              min={1}
              step={1}
              disabled={busy || !form.maxPerStream.enabled}
              value={form.maxPerStream.max}
              onChange={event => onChange(current => ({ ...current, maxPerStream: { ...current.maxPerStream, max: Number(event.target.value) } }))}
            />
          </div>
        </div>
        <div className="field reward-form-limits">
          <span>Max per user per stream</span>
          <div className="reward-limit-row">
            <label className="command-enabled">
              <input
                type="checkbox"
                checked={form.maxPerUserPerStream.enabled}
                disabled={busy}
                onChange={event => onChange(current => ({ ...current, maxPerUserPerStream: { ...current.maxPerUserPerStream, enabled: event.target.checked } }))}
              />
              Enable
            </label>
            <input
              type="number"
              min={1}
              step={1}
              disabled={busy || !form.maxPerUserPerStream.enabled}
              value={form.maxPerUserPerStream.max}
              onChange={event => onChange(current => ({ ...current, maxPerUserPerStream: { ...current.maxPerUserPerStream, max: Number(event.target.value) } }))}
            />
          </div>
        </div>
        <label className="command-enabled reward-form-enabled">
          <input
            type="checkbox"
            checked={form.isUserInputRequired}
            disabled={busy}
            onChange={event => onChange(current => ({ ...current, isUserInputRequired: event.target.checked }))}
          />
          Viewers must enter text when redeeming
        </label>
        <label className="command-enabled reward-form-enabled">
          <input
            type="checkbox"
            checked={form.isEnabled}
            disabled={busy}
            onChange={event => onChange(current => ({ ...current, isEnabled: event.target.checked }))}
          />
          Enabled on Twitch
        </label>
      </div>
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
  ttsEnabled,
  onEdit,
  onDelete,
  onCategoryChange,
  onTtsToggle,
}: {
  reward: ViewerReward;
  categories: ViewerRewardCategory[];
  busy: boolean;
  ttsEnabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCategoryChange: (categoryId: string | null) => void;
  onTtsToggle: () => void;
}) {
  return (
    <div className={'reward-row' + (reward.isEnabled ? '' : ' disabled')}>
      <div className="reward-art" style={{ backgroundColor: reward.backgroundColor }}>
        {reward.imageUrl ? <img src={reward.imageUrl} alt="" /> : null}
      </div>
      <div className="reward-main">
        <div className="reward-title-line">
          <b>{reward.title}</b>
          <span className={reward.isEnabled ? 'reward-state on' : 'reward-state'}>{reward.isEnabled ? 'On' : 'Off'}</span>
          {!reward.canManage ? <span className="reward-state readonly">Twitch-managed</span> : null}
        </div>
        <div className="reward-meta">{reward.cost.toLocaleString()} points{reward.prompt ? ` · ${reward.prompt}` : ''}</div>
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
        {reward.isUserInputRequired && (
          <button
            className={'modbtn' + (ttsEnabled ? ' gold' : '')}
            type="button"
            disabled={busy}
            title={ttsEnabled ? 'TTS enabled — click to disable' : 'Enable TTS for this reward'}
            onClick={onTtsToggle}
          >
            TTS
          </button>
        )}
        <button className="modbtn" type="button" disabled={busy || !reward.canManage} onClick={onEdit}>Edit</button>
        <button className="modbtn danger" type="button" disabled={busy || !reward.canManage} onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

export function ViewerRewardsPage({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<ViewerRewardsResponse>({ categories: [], rewards: [] });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rewardForm, setRewardForm] = useState<ViewerRewardUpsert>(EMPTY_REWARD);
  const [ttsEnabledIds, setTtsEnabledIds] = useState<Set<string>>(new Set());

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
      const [rewards, ttsIds] = await Promise.all([getViewerRewards(), getTtsEnabledRewards()]);
      setData(rewards);
      setTtsEnabledIds(new Set(ttsIds));
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load viewer rewards.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const handleTtsToggle = async (reward: ViewerReward) => {
    const next = !ttsEnabledIds.has(reward.id);
    setBusyId(reward.id);
    try {
      await setTtsRewardEnabled(reward.id, next);
      setTtsEnabledIds(current => {
        const updated = new Set(current);
        if (next) updated.add(reward.id); else updated.delete(reward.id);
        return updated;
      });
      setMessage(next ? `TTS enabled for "${reward.title}".` : `TTS disabled for "${reward.title}".`);
    } catch (toggleError) {
      setError(errorMessage(toggleError, 'Could not update TTS setting.'));
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
        <div className="reward-list">
          {rewards.length === 0 ? (
            <div className="reward-empty">No rewards in this category.</div>
          ) : rewards.map(reward => (
            <RewardRow
              key={reward.id}
              reward={reward}
              categories={data.categories}
              busy={Boolean(busyId)}
              ttsEnabled={ttsEnabledIds.has(reward.id)}
              onEdit={() => startEdit(reward)}
              onDelete={() => void handleRewardDelete(reward)}
              onCategoryChange={categoryId => void handleCategoryAssignment(reward, categoryId)}
              onTtsToggle={() => void handleTtsToggle(reward)}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="settings-page rewards-page">
      <div className="settings-inner rewards-inner">
        <div className="rewards-header">
          <div>
            <div className="settings-eyebrow">settings</div>
            <h2 className="settings-title">Viewer rewards</h2>
            <p className="set-intro">Create and organize Twitch Channel Points rewards. Toggle a category to switch its manageable rewards on or off together.</p>
          </div>
          <button className="btn-primary" type="button" disabled={loading || Boolean(busyId)} onClick={() => startCreate()}>New reward</button>
        </div>

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
    </div>
  );
}
