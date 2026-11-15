import React from 'react';
import { useConfirm } from '../ui/confirm';
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
import { formatBoxArtUrl, suggestionFace, suggestionFailedText, useDebouncedSuggestions } from '../suggestions';
import { SUGGESTION_DISMISS_MS } from '../../shared/constants';
import { Icon } from '../ui/icons';
import { ListUnavailable, SettingsHeader, SettingsStatus } from './settings/shared';
import { listFace } from './settings/listState';
import { errorMessage } from '../errors';
import { EmptyState } from '../ui/emptyState';
import { useDirtyGuard, useOpenIds } from '../ui/dirtyGuard';
import { keepOpenInView } from '../ui/dirtyGuardLogic';

function normalizeTagInput(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
}

function CategoryCard({
  category,
  busy,
  setOpen,
  onSaveTags,
  onToggleHidden,
  onDelete,
}: {
  category: SavedStreamCategory;
  busy: boolean;
  setOpen: (id: string, open: boolean) => void;
  onSaveTags: (tags: string[]) => void;
  onToggleHidden: () => void;
  onDelete: () => void;
}) {
  const [tags, setTags] = React.useState<string[]>(category.tags);
  const [tagInput, setTagInput] = React.useState('');
  const [tagFocused, setTagFocused] = React.useState(false);
  const dirty = tags.join(' ') !== category.tags.join(' ');
  useDirtyGuard(dirty, `the tags for ${category.name}`);
  // Unsaved tags keep this card listed past "Show hidden" (keepOpenInView): hiding it,
  // or turning the filter off, would otherwise unmount it and drop the tags unasked.
  React.useEffect(() => { setOpen(category.id, dirty); }, [setOpen, category.id, dirty]);
  React.useEffect(() => () => setOpen(category.id, false), [setOpen, category.id]);

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
  const { suggestions, loading, error: tagSearchError } = useDebouncedSuggestions(tagInput, tagFetcher, { minLength: 1 });
  const tagFace = suggestionFace({ loading, error: tagSearchError, count: suggestions.length });
  // An empty answer shows nothing (a tag is typed freely); a failed one says so.
  const showSuggestions = tagFocused && tagFace !== 'none';

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
                <span className="cat-group" key={group.id} title="Reward group that switches on with this category"><Icon name="gem" size={10} aria-hidden="true" />{group.name}</span>
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
                {tagFace === 'searching' ? (
                  <div className="suggestion-empty">Searching tags...</div>
                ) : tagFace === 'failed' ? (
                  <div className="suggestion-empty suggestion-empty--error">{suggestionFailedText(tagSearchError ?? '')}</div>
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
  const { suggestions, loading, error: searchError } = useDebouncedSuggestions(search, getCategorySuggestions, { enabled: !busy });
  const face = suggestionFace({ loading, error: searchError, count: suggestions.length });
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
                if (suggestions[0]) pick(suggestions[0]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setSearch('');
              }
            }}
          />
          {showSuggestions && (
            <div className="suggestion-list">
              {face === 'searching' ? (
                <div className="suggestion-empty">Searching categories...</div>
              ) : face === 'failed' ? (
                <div className="suggestion-empty suggestion-empty--error">{suggestionFailedText(searchError ?? '')}</div>
              ) : face === 'none' ? (
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
  const confirm = useConfirm();
  const [categories, setCategories] = React.useState<SavedStreamCategory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  // A failed load is not "no saved categories" — see listFace. Cleared by any call
  // that hands back the whole list, since each mutation returns it.
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const [showHidden, setShowHidden] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Cleared so a retry that fails the same way still changes the alert, and is
    // announced again rather than leaving the reader with nothing.
    setError(null);
    getSavedStreamCategories()
      .then(next => {
        if (cancelled) return;
        setCategories(next);
        setLoadFailed(false);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setLoadFailed(true);
        setError(errorMessage(caught, 'Could not load stream categories.'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadAttempt]);

  /**
   * Every write goes through here and reports itself on the page's one
   * `SettingsStatus` line — the outcome when it worked as well as when it failed (the
   * feedback rule in settings/shared.tsx).
   */
  const run = async (action: () => Promise<SavedStreamCategory[]>, done: string, failed: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setCategories(await action());
      setLoadFailed(false);
      setMessage(done);
    } catch (caught) {
      setError(errorMessage(caught, failed));
    } finally {
      setBusy(false);
    }
  };

  const { open: dirtyIds, setOpen } = useOpenIds<string>();
  const visible = keepOpenInView(categories, cat => showHidden || !cat.hidden, dirtyIds, cat => cat.id);
  const hiddenCount = categories.filter(cat => cat.hidden).length;
  const face = listFace({ loading, loadFailed, count: categories.length });

  return (
    <div className="cats-page">
        <SettingsHeader
          section="categories"
          counts={loadFailed ? undefined : [
            { value: categories.length, one: 'saved', other: 'saved' },
            { value: hiddenCount, one: 'hidden', other: 'hidden', hideWhenZero: true },
          ]}
        />

        <AddCategoryControl
          busy={busy}
          onAdd={suggestion => void run(
            () => addSavedStreamCategory({ id: suggestion.id, name: suggestion.name, boxArtUrl: suggestion.boxArtUrl }),
            `Added ${suggestion.name}.`,
            `Could not add ${suggestion.name}.`,
          )}
        />

        <SettingsStatus message={message} error={error} />

        {face === 'loading' ? (
          <EmptyState title="Charting your categories…" />
        ) : face === 'unavailable' ? (
          <ListUnavailable title="Saved categories unavailable" onRetry={() => setLoadAttempt(n => n + 1)} retrying={loading} />
        ) : face === 'empty' ? (
          <EmptyState title="No saved categories yet">Search for a category above to add your first one — or pick one in Stream Info and it lands here.</EmptyState>
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
                  setOpen={setOpen}
                  onSaveTags={tags => void run(
                    () => setStreamCategoryTags(category.id, tags),
                    `Tags saved for ${category.name}.`,
                    `Could not save the tags for ${category.name}.`,
                  )}
                  onToggleHidden={() => void run(
                    () => setSavedStreamCategoryHidden(category.id, !category.hidden),
                    category.hidden ? `${category.name} is shown in pickers again.` : `${category.name} is hidden from pickers.`,
                    `Could not ${category.hidden ? 'show' : 'hide'} ${category.name}.`,
                  )}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: `Remove "${category.name}"?`,
                      body: 'It leaves your saved categories, and its tag mappings are deleted with it.',
                      confirmLabel: 'Remove category',
                      tone: 'danger',
                    });
                    if (ok) void run(
                      () => deleteStreamCategory(category.id),
                      `Removed ${category.name}.`,
                      `Could not remove ${category.name}.`,
                    );
                  }}
                />
              ))}
            </div>
          </>
        )}
    </div>
  );
}
