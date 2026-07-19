import React from 'react';
import type { SavedStreamCategory, TwitchCategorySuggestion } from '../../shared/api';
import {
  addSavedStreamCategory,
  deleteStreamCategory,
  getCategorySuggestions,
  getSavedStreamCategories,
  getTagHistorySuggestions,
  setSavedStreamCategoryHidden,
  setStreamCategoryTags,
} from '../services/dashboard';
import { formatBoxArtUrl, useDebouncedSuggestions } from '../suggestions';
import { SUGGESTION_DISMISS_MS } from '../../shared/constants';
import { Icon } from '../ui/icons';
import { SettingsHeader } from './settings/shared';
import { errorMessage } from '../errors';

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

  // Any save/hide/delete replaces the whole category list, handing every card a
  // fresh `tags` array. Sync local state only when THIS card's persisted value
  // actually changed (e.g. its own save) — otherwise a refresh triggered by
  // another card would silently discard unsaved edits here.
  const syncedTags = React.useRef(category.tags.join('\n'));
  React.useEffect(() => {
    const serverKey = category.tags.join('\n');
    if (serverKey !== syncedTags.current) {
      syncedTags.current = serverKey;
      setTags(category.tags);
    }
  }, [category.tags]);

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

  const art = formatBoxArtUrl(category.boxArtUrl, 120, 160);
  return (
    <div className={'cat-card' + (category.hidden ? ' is-hidden' : '')}>
      <div className="cat-card-head">
        <div className="cat-crest">
          {art ? <img src={art} alt="" /> : <span className="cat-crest-empty" aria-hidden="true" />}
        </div>
        <div className="cat-card-id">
          <div className="cat-card-name">{category.name}</div>
          {category.rewardGroups.length > 0 ? (
            <div className="cat-groups">
              {category.rewardGroups.map(group => (
                <span className="cat-group" key={group.id} title="Reward group that switches on with this category">◆ {group.name}</span>
              ))}
            </div>
          ) : (
            <div className="cat-card-note">{category.hidden ? 'Hidden from pickers' : 'No reward groups linked'}</div>
          )}
        </div>
        <div className="cat-card-acts">
          <button className="modbtn" type="button" disabled={busy} onClick={onToggleHidden}>
            {category.hidden ? 'Show' : 'Hide'}
          </button>
          <button className="modbtn danger" type="button" disabled={busy} onClick={onDelete}>Remove</button>
        </div>
      </div>

      <div className="cat-tags">
        <div className="cat-tags-label">Tags on switch</div>
        <div className="cat-tagfield">
          {tags.map(tag => (
            <span className="tag-chip" key={tag}>
              {tag}
              <button type="button" title={`Remove ${tag}`} onClick={() => removeTag(tag)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <div className="cat-tag-input suggestion-anchor">
            <input
              aria-label={`Add tag to ${category.name}`}
              placeholder={tags.length === 0 ? 'Add a tag…' : ''}
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
        </div>
        <div className="cat-tags-foot">
          <small>{tags.length}/10</small>
          <button className="modbtn gold" type="button" disabled={busy || !dirty} onClick={() => onSaveTags(tags)}>
            {dirty ? 'Save tags' : 'Saved'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddCategoryControl({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (suggestion: TwitchCategorySuggestion) => void;
}) {
  const [search, setSearch] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const { suggestions, loading } = useDebouncedSuggestions(search, getCategorySuggestions, { enabled: !busy });
  const showSuggestions = focused && (loading || suggestions.length > 0 || search.trim().length >= 2);

  const pick = (suggestion: TwitchCategorySuggestion) => {
    onAdd(suggestion);
    setSearch('');
    setFocused(false);
  };

  return (
    /* `field` is what dresses the input: there is no global `input {}` rule, so every
       text-input style in the app comes from the descendant selector `.field input`.
       Without it this box rendered as a raw white system default on a dark card — and
       at its intrinsic ~184px while the suggestion dropdown anchored to it stretched
       to the full 420px. StreamInfoModal wraps the identical widget the same way. */
    <div className="field cats-add">
      <span>Add a category</span>
      <div className="stream-cat-picker">
        <div className="suggestion-anchor">
          <input
            aria-label="Search Twitch categories to add"
            value={search}
            placeholder="Search Twitch categories…"
            disabled={busy}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), SUGGESTION_DISMISS_MS)}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (suggestions.length > 0) pick(suggestions[0]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setSearch('');
              }
            }}
          />
          {showSuggestions && (
            <div className="suggestion-list">
              {loading ? (
                <div className="suggestion-empty">Searching categories...</div>
              ) : suggestions.length === 0 ? (
                <div className="suggestion-empty">No matches</div>
              ) : suggestions.map(category => (
                <button
                  key={category.id}
                  type="button"
                  className="suggestion-item"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => pick(category)}
                >
                  <span>{category.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function StreamCategoriesPage() {
  const [categories, setCategories] = React.useState<SavedStreamCategory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);

  React.useEffect(() => {
    getSavedStreamCategories()
      .then(setCategories)
      .catch((caught: unknown) => setError(errorMessage(caught, 'Could not load stream categories.')))
      .finally(() => setLoading(false));
  }, []);

  const run = async (action: () => Promise<SavedStreamCategory[]>) => {
    setBusy(true);
    setError(null);
    try {
      setCategories(await action());
    } catch (caught) {
      setError(errorMessage(caught, 'Action failed.'));
    } finally {
      setBusy(false);
    }
  };

  const visible = categories.filter(cat => showHidden || !cat.hidden);
  const hiddenCount = categories.filter(cat => cat.hidden).length;

  return (
    <div className="cats-page">
        <SettingsHeader
          section="categories"
          meta={
            <p className="cats-count">
              <b>{categories.length}</b> saved
              {hiddenCount > 0 ? <><span className="cats-count-dot" /><b>{hiddenCount}</b> hidden</> : null}
            </p>
          }
        />

        <AddCategoryControl
          busy={busy}
          onAdd={suggestion => void run(() => addSavedStreamCategory({ id: suggestion.id, name: suggestion.name, boxArtUrl: suggestion.boxArtUrl }))}
        />

        {error ? <div className="viewers-status is-error" role="status">{error}</div> : null}

        {loading ? (
          <div className="empty-state"><div className="es-orb" /><div className="es-title">Charting your categories…</div></div>
        ) : categories.length === 0 ? (
          <div className="empty-state">
            <div className="es-orb" />
            <div className="es-title">No saved categories yet</div>
            <div className="es-sub">Search for a category above to add your first one — or pick one in Stream Info and it lands here.</div>
          </div>
        ) : (
          <>
            {hiddenCount > 0 && (
              <div className="cats-toolbar">
                <button
                  type="button"
                  className={'viewers-chip' + (showHidden ? ' is-active' : '')}
                  aria-pressed={showHidden}
                  onClick={() => setShowHidden(v => !v)}
                >
                  Show hidden<span className="viewers-chip-n">{hiddenCount}</span>
                </button>
              </div>
            )}
            <div className="cat-grid">
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
            </div>
          </>
        )}
    </div>
  );
}
