import React from 'react';
import { Icon } from '../ui/icons';
import { addSavedStreamCategory, getCategorySuggestions, getSavedStreamCategories, getTagSuggestions } from '../services/dashboard';
import { useDebouncedSuggestions } from '../suggestions';
import { SUGGESTION_DISMISS_MS } from '../../shared/constants';
import type { SavedStreamCategory, TwitchCategorySuggestion } from '../../shared/api';

export type StreamInfoForm = { title: string; category: string; categoryId?: string; tags: string[] };

function normalizeTagInput(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
}

export function StreamInfoModal({
  form,
  loading,
  saving,
  message,
  error,
  setForm,
  onSubmit,
  onClose,
}: {
  form: StreamInfoForm;
  loading: boolean;
  saving: boolean;
  message: string | null;
  error: string | null;
  setForm: React.Dispatch<React.SetStateAction<StreamInfoForm>>;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const [categoryFocused, setCategoryFocused] = React.useState(false);
  const [savedCategories, setSavedCategories] = React.useState<SavedStreamCategory[]>([]);
  const [categoryMode, setCategoryMode] = React.useState<'select' | 'search'>('select');
  const [categorySearch, setCategorySearch] = React.useState('');
  const [tagInput, setTagInput] = React.useState('');
  const [tagFocused, setTagFocused] = React.useState(false);

  // Every category that has been the live selection this session, so a mis-pick can't strand it out of the list.
  const seenCategoriesRef = React.useRef<Map<string, SavedStreamCategory>>(new Map());

  React.useEffect(() => {
    void getSavedStreamCategories().then(setSavedCategories).catch(() => setSavedCategories([]));
  }, []);

  React.useEffect(() => {
    if (form.categoryId && form.category) {
      seenCategoriesRef.current.set(form.categoryId, { id: form.categoryId, name: form.category, boxArtUrl: null, hidden: false, tags: [], rewardGroups: [] });
    }
  }, [form.categoryId, form.category]);

  const { suggestions: categorySuggestions, loading: categoryLoading } = useDebouncedSuggestions(
    categorySearch,
    getCategorySuggestions,
    { enabled: !loading },
  );

  const tagFetcher = React.useCallback(
    (query: string) => getTagSuggestions(query).then(list => {
      const selected = new Set(form.tags.map(tag => tag.toLowerCase()));
      return list.filter(tag => !selected.has(tag.toLowerCase()));
    }),
    [form.tags],
  );
  const { suggestions: tagSuggestions, loading: tagLoading } = useDebouncedSuggestions(
    tagInput,
    tagFetcher,
    { minLength: 1, enabled: !loading },
  );

  const addTag = React.useCallback((value: string) => {
    const tag = normalizeTagInput(value);
    if (!tag) return;
    setForm(current => {
      if (current.tags.length >= 10 || current.tags.some(item => item.toLowerCase() === tag.toLowerCase())) {
        return current;
      }
      return { ...current, tags: [...current.tags, tag] };
    });
    setTagInput('');
  }, [setForm]);

  const removeTag = React.useCallback((tag: string) => {
    setForm(current => ({ ...current, tags: current.tags.filter(item => item !== tag) }));
  }, [setForm]);

  // Apply a category selection to the form. Loads that category's saved
  // "tags on switch" set from `sourceCategories` when it defines one, and
  // leaves the current tags untouched when it doesn't — so picking an
  // untagged category never wipes what's already there. Shared by the
  // dropdown and the search/"Add" flows so both behave identically.
  const applyCategorySelection = React.useCallback(
    (id: string, name: string, sourceCategories: SavedStreamCategory[]) => {
      const savedTags = sourceCategories.find(cat => cat.id === id)?.tags ?? [];
      setForm(current => ({
        ...current,
        category: name,
        categoryId: id,
        tags: savedTags.length > 0 ? savedTags : current.tags,
      }));
    },
    [setForm],
  );

  const showCategorySuggestions = categoryFocused
    && (categoryLoading || categorySuggestions.length > 0 || categorySearch.trim().length >= 2);
  const showTagSuggestions = tagFocused && (tagLoading || tagSuggestions.length > 0);

  // Saved categories to choose from; keep the current + previously-selected ones even when unsaved/hidden.
  const visibleSaved = savedCategories.filter(cat => !cat.hidden);
  const savedIds = new Set(visibleSaved.map(cat => cat.id));
  const remembered = new Map(seenCategoriesRef.current);
  if (form.categoryId && form.category) {
    remembered.set(form.categoryId, { id: form.categoryId, name: form.category, boxArtUrl: null, hidden: false, tags: [], rewardGroups: [] });
  }
  const categoryOptions: SavedStreamCategory[] = [
    ...[...remembered.values()].filter(cat => !savedIds.has(cat.id)),
    ...visibleSaved,
  ];

  const addSearchedCategory = (suggestion: TwitchCategorySuggestion) => {
    // Seed from the list we have now, then re-apply once the upsert returns the
    // refreshed list — a re-added category we've tagged before then loads its tags.
    applyCategorySelection(suggestion.id, suggestion.name, savedCategories);
    void addSavedStreamCategory({ id: suggestion.id, name: suggestion.name, boxArtUrl: suggestion.boxArtUrl })
      .then(next => {
        setSavedCategories(next);
        applyCategorySelection(suggestion.id, suggestion.name, next);
      })
      .catch(() => undefined);
    setCategoryMode('select');
    setCategorySearch('');
    setCategoryFocused(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="stream-info-modal" onSubmit={onSubmit}>
        <div className="modal-head">
          <div>
            <h2>Stream Info</h2>
          </div>
          <button className="icon-btn" type="button" title="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <label className="field">
          <span>Title</span>
          <input
            value={form.title}
            maxLength={140}
            disabled={loading || saving}
            onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
          />
          <small>{form.title.length}/140</small>
        </label>

        <div className="field">
          <span>Category</span>
          {categoryMode === 'search' ? (
            <div className="stream-cat-picker">
              <div className="suggestion-anchor">
                <input
                  aria-label="Search categories"
                  autoFocus
                  value={categorySearch}
                  placeholder="Search Twitch categories…"
                  disabled={loading || saving}
                  onFocus={() => setCategoryFocused(true)}
                  onBlur={() => window.setTimeout(() => setCategoryFocused(false), SUGGESTION_DISMISS_MS)}
                  onChange={event => setCategorySearch(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (categorySuggestions.length > 0) addSearchedCategory(categorySuggestions[0]);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setCategoryMode('select');
                      setCategorySearch('');
                    }
                  }}
                />
                {showCategorySuggestions && (
                  <div className="suggestion-list">
                    {categoryLoading ? (
                      <div className="suggestion-empty">Searching categories...</div>
                    ) : categorySuggestions.length === 0 ? (
                      <div className="suggestion-empty">No matches</div>
                    ) : categorySuggestions.map(category => (
                      <button
                        key={category.id}
                        type="button"
                        className="suggestion-item"
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => addSearchedCategory(category)}
                      >
                        <span>{category.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="modbtn"
                disabled={loading || saving}
                onClick={() => { setCategoryMode('select'); setCategorySearch(''); }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="stream-cat-picker">
              <select
                aria-label="Category"
                value={form.categoryId ?? ''}
                disabled={loading || saving}
                onChange={event => {
                  const picked = categoryOptions.find(option => option.id === event.target.value);
                  if (!picked) return;
                  // The saved list carries each category's tag set; a remembered stub may not.
                  applyCategorySelection(picked.id, picked.name, savedCategories);
                }}
              >
                <option value="" disabled>{categoryOptions.length ? 'Select a category…' : 'No saved categories — use Add'}</option>
                {categoryOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
              <button
                type="button"
                className="modbtn"
                disabled={loading || saving}
                onClick={() => { setCategoryMode('search'); setCategorySearch(''); }}
              >
                Add
              </button>
            </div>
          )}
        </div>

        <div className="field">
          <span>Tags</span>
          <div className="tag-chip-list">
            {form.tags.map(tag => (
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
              aria-label="Tag suggestion"
              value={tagInput}
              disabled={loading || saving || form.tags.length >= 10}
              onFocus={() => setTagFocused(true)}
              onBlur={() => window.setTimeout(() => setTagFocused(false), SUGGESTION_DISMISS_MS)}
              onChange={event => setTagInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag(tagInput);
                }
              }}
            />
            {showTagSuggestions && (
              <div className="suggestion-list">
                {tagLoading ? (
                  <div className="suggestion-empty">Searching tags...</div>
                ) : tagSuggestions.map(tag => (
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
          <small>{form.tags.length}/10</small>
        </div>

        {(loading || message || error) && (
          <div className={'modal-status' + (error ? ' error' : '')}>
            {loading ? 'Loading current stream info...' : error ?? message}
          </div>
        )}

        <div className="modal-actions">
          <button className="modbtn" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modbtn gold" type="submit" disabled={loading || saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
