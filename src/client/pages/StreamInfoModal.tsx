import React from 'react';
import { Icon } from '../ui/icons';
import { getCategorySuggestions, getTagSuggestions } from '../services/dashboard';
import type { TwitchCategorySuggestion } from '../../shared/api';

export type StreamInfoForm = { title: string; category: string; tags: string[] };

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
  const [categorySuggestions, setCategorySuggestions] = React.useState<TwitchCategorySuggestion[]>([]);
  const [categoryLoading, setCategoryLoading] = React.useState(false);
  const [categoryFocused, setCategoryFocused] = React.useState(false);
  const [tagInput, setTagInput] = React.useState('');
  const [tagSuggestions, setTagSuggestions] = React.useState<string[]>([]);
  const [tagLoading, setTagLoading] = React.useState(false);
  const [tagFocused, setTagFocused] = React.useState(false);

  React.useEffect(() => {
    const query = form.category.trim();
    if (query.length < 2 || loading) {
      setCategorySuggestions([]);
      setCategoryLoading(false);
      return;
    }

    let cancelled = false;
    setCategoryLoading(true);
    const timeout = window.setTimeout(() => {
      void getCategorySuggestions(query)
        .then(suggestions => {
          if (!cancelled) setCategorySuggestions(suggestions);
        })
        .catch((fetchError: unknown) => {
          console.error('Failed to load category suggestions:', fetchError);
          if (!cancelled) setCategorySuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setCategoryLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [form.category, loading]);

  React.useEffect(() => {
    const query = tagInput.trim();
    if (!query || loading) {
      setTagSuggestions([]);
      setTagLoading(false);
      return;
    }

    let cancelled = false;
    setTagLoading(true);
    const timeout = window.setTimeout(() => {
      void getTagSuggestions(query)
        .then(suggestions => {
          if (!cancelled) {
            const selected = new Set(form.tags.map(tag => tag.toLowerCase()));
            setTagSuggestions(suggestions.filter(tag => !selected.has(tag.toLowerCase())));
          }
        })
        .catch((fetchError: unknown) => {
          console.error('Failed to load tag suggestions:', fetchError);
          if (!cancelled) setTagSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setTagLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [form.tags, loading, tagInput]);

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
    setTagSuggestions([]);
  }, [setForm]);

  const removeTag = React.useCallback((tag: string) => {
    setForm(current => ({ ...current, tags: current.tags.filter(item => item !== tag) }));
  }, [setForm]);

  const showCategorySuggestions = categoryFocused && (categoryLoading || categorySuggestions.length > 0);
  const showTagSuggestions = tagFocused && (tagLoading || tagSuggestions.length > 0);

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
          <div className="suggestion-anchor">
            <input
              aria-label="Category"
              value={form.category}
              disabled={loading || saving}
              onFocus={() => setCategoryFocused(true)}
              onBlur={() => window.setTimeout(() => setCategoryFocused(false), 120)}
              onChange={event => setForm(current => ({ ...current, category: event.target.value }))}
            />
            {showCategorySuggestions && (
              <div className="suggestion-list">
                {categoryLoading ? (
                  <div className="suggestion-empty">Searching categories...</div>
                ) : categorySuggestions.map(category => (
                  <button
                    key={category.id}
                    type="button"
                    className="suggestion-item"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => {
                      setForm(current => ({ ...current, category: category.name }));
                      setCategorySuggestions([]);
                      setCategoryFocused(false);
                    }}
                  >
                    <span>{category.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
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
              onBlur={() => window.setTimeout(() => setTagFocused(false), 120)}
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
