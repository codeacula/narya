import React from 'react';
import type { SavedStreamCategory } from '../../shared/api';
import {
  deleteStreamCategory,
  getSavedStreamCategories,
  getTagHistorySuggestions,
  setSavedStreamCategoryHidden,
  setStreamCategoryTags,
} from '../services/dashboard';
import { formatBoxArtUrl, useDebouncedSuggestions } from '../suggestions';
import { SUGGESTION_DISMISS_MS } from '../../shared/constants';
import { Icon } from '../ui/icons';

function normalizeTagInput(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
}

function CategoryCard({
  category,
  busy,
  onSaveTags,
  onToggleHidden,
  onDelete,
}: {
  category: SavedStreamCategory;
  busy: boolean;
  onSaveTags: (tags: string[]) => void;
  onToggleHidden: () => void;
  onDelete: () => void;
}) {
  const [tags, setTags] = React.useState<string[]>(category.tags);
  const [tagInput, setTagInput] = React.useState('');
  const [tagFocused, setTagFocused] = React.useState(false);
  const dirty = tags.join(' ') !== category.tags.join(' ');

  // Keep local edits in sync when the server list refreshes after a save.
  React.useEffect(() => { setTags(category.tags); }, [category.tags]);

  const tagFetcher = React.useCallback(
    (query: string) => getTagHistorySuggestions(query).then(list => {
      const selected = new Set(tags.map(t => t.toLowerCase()));
      return list.filter(t => !selected.has(t.toLowerCase()));
    }),
    [tags],
  );
  const { suggestions, loading } = useDebouncedSuggestions(tagInput, tagFetcher, { minLength: 1 });
  const showSuggestions = tagFocused && (loading || suggestions.length > 0);

  const addTag = (value: string) => {
    const tag = normalizeTagInput(value);
    if (!tag) return;
    setTags(current => (current.length >= 10 || current.some(t => t.toLowerCase() === tag.toLowerCase()) ? current : [...current, tag]));
    setTagInput('');
  };
  const removeTag = (tag: string) => setTags(current => current.filter(t => t !== tag));

  const art = formatBoxArtUrl(category.boxArtUrl, 36, 48);
  return (
    <div className={'set-group category-card' + (category.hidden ? ' is-hidden' : '')}>
      <div className="category-card-head">
        {art ? <img className="suggestion-art" src={art} alt="" /> : <span className="suggestion-art placeholder" />}
        <div className="category-card-title">
          <b>{category.name}</b>
          {category.hidden ? <span className="reward-state">Hidden</span> : null}
        </div>
        <div className="category-card-actions">
          <button className="modbtn" type="button" disabled={busy} onClick={onToggleHidden}>
            {category.hidden ? 'Unhide' : 'Hide'}
          </button>
          <button className="modbtn danger" type="button" disabled={busy} onClick={onDelete}>Remove</button>
        </div>
      </div>

      <div className="field">
        <span>Tags applied when you switch to this category</span>
        <div className="tag-chip-list">
          {tags.map(tag => (
            <span className="tag-chip" key={tag}>
              {tag}
              <button type="button" title={`Remove ${tag}`} onClick={() => removeTag(tag)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="suggestion-anchor">
          <input
            aria-label={`Add tag to ${category.name}`}
            value={tagInput}
            disabled={busy || tags.length >= 10}
            onFocus={() => setTagFocused(true)}
            onBlur={() => window.setTimeout(() => setTagFocused(false), SUGGESTION_DISMISS_MS)}
            onChange={event => setTagInput(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(tagInput); } }}
          />
          {showSuggestions && (
            <div className="suggestion-list">
              {loading ? (
                <div className="suggestion-empty">Searching tags...</div>
              ) : suggestions.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className="suggestion-item"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => addTag(tag)}
                >
                  <span>{tag}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="category-card-tagsave">
          <small>{tags.length}/10</small>
          <button className="modbtn gold" type="button" disabled={busy || !dirty} onClick={() => onSaveTags(tags)}>
            {dirty ? 'Save tags' : 'Saved'}
          </button>
        </div>
      </div>

      {category.rewardGroups.length > 0 && (
        <div className="field">
          <span>Reward groups that switch with this category</span>
          <div className="tag-chip-list">
            {category.rewardGroups.map(group => (
              <span className="tag-chip" key={group.id}>{group.name}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StreamCategoriesPage({ onBack }: { onBack: () => void }) {
  const [categories, setCategories] = React.useState<SavedStreamCategory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);

  React.useEffect(() => {
    getSavedStreamCategories()
      .then(setCategories)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load stream categories.'))
      .finally(() => setLoading(false));
  }, []);

  const run = async (action: () => Promise<SavedStreamCategory[]>) => {
    setBusy(true);
    setError(null);
    try {
      setCategories(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const visible = categories.filter(cat => showHidden || !cat.hidden);
  const hiddenCount = categories.filter(cat => cat.hidden).length;

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="rewards-header">
          <div>
            <div className="settings-eyebrow">settings</div>
            <h2 className="settings-title">Stream categories</h2>
            <p className="set-intro">Manage the Twitch categories you stream. Tags you assign here replace your stream tags automatically when you switch to that category in Stream Info.</p>
          </div>
          <button className="modbtn" type="button" onClick={onBack}>Back to settings</button>
        </div>

        {error ? <div className="set-status error">{error}</div> : null}

        {loading ? (
          <div className="reward-loading">Loading stream categories...</div>
        ) : categories.length === 0 ? (
          <div className="reward-empty-state">
            <h3>No saved categories yet</h3>
            <p>Categories are saved automatically when you pick one in Stream Info or map one to a reward group.</p>
          </div>
        ) : (
          <>
            {hiddenCount > 0 && (
              <label className="reward-toggle">
                <input type="checkbox" checked={showHidden} onChange={() => setShowHidden(v => !v)} />
                <span>Show hidden ({hiddenCount})</span>
              </label>
            )}
            {visible.map(category => (
              <CategoryCard
                key={category.id}
                category={category}
                busy={busy}
                onSaveTags={tags => void run(() => setStreamCategoryTags(category.id, tags))}
                onToggleHidden={() => void run(() => setSavedStreamCategoryHidden(category.id, !category.hidden))}
                onDelete={() => {
                  if (window.confirm(`Remove "${category.name}" from saved categories? Its tag mappings are deleted.`)) {
                    void run(() => deleteStreamCategory(category.id));
                  }
                }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
