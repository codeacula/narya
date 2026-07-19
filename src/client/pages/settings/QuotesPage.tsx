import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Quote } from '../../../shared/api';
import { MAX_QUOTE_LENGTH, MAX_QUOTE_SLUG_LENGTH } from '../../../shared/api';
import { createQuote, deleteQuote, getQuotes, updateQuote } from '../../services/dashboard';
import { SettingsHeader, SettingsStatus } from './shared';
import { errorMessage } from '../../errors';
import { formatAgo } from '../../../shared/time';

type Draft = { text: string; slug: string; submittedBy: string };

const EMPTY_DRAFT: Draft = { text: '', slug: '', submittedBy: '' };

/**
 * One quote. Editing is inline and local until saved, so a refresh caused by another
 * card's save cannot discard edits in progress here — the same reason the category
 * cards keep their own draft state.
 */
function QuoteCard({ quote, busy, onSave, onDelete }: {
  quote: Quote;
  busy: boolean;
  onSave: (draft: Draft) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    text: quote.text,
    slug: quote.slug ?? '',
    submittedBy: quote.submittedBy,
  });

  const reset = () => {
    setDraft({ text: quote.text, slug: quote.slug ?? '', submittedBy: quote.submittedBy });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="quote-card quote-card--editing">
        <div className="quote-number">#{quote.number}</div>
        <div className="quote-body">
          <label className="field settings-wide-field">
            <span>Quote</span>
            <input
              value={draft.text}
              disabled={busy}
              maxLength={MAX_QUOTE_LENGTH}
              onChange={event => setDraft({ ...draft, text: event.target.value })}
            />
          </label>
          <div className="quote-edit-row">
            <label className="field">
              <span>Keyword</span>
              <input
                value={draft.slug}
                disabled={busy}
                maxLength={MAX_QUOTE_SLUG_LENGTH}
                placeholder="none"
                onChange={event => setDraft({ ...draft, slug: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Submitted by</span>
              <input
                value={draft.submittedBy}
                disabled={busy}
                maxLength={60}
                onChange={event => setDraft({ ...draft, submittedBy: event.target.value })}
              />
            </label>
          </div>
          <div className="quote-acts">
            <button className="modbtn gold" type="button" disabled={busy || !draft.text.trim()} onClick={() => onSave(draft)}>
              Save
            </button>
            <button className="modbtn" type="button" disabled={busy} onClick={reset}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="quote-card">
      <div className="quote-number">#{quote.number}</div>
      <div className="quote-body">
        <blockquote className="quote-text">{quote.text}</blockquote>
        <div className="quote-meta">
          {quote.slug && <span className="tag-chip" title="Call it with this keyword">{quote.slug}</span>}
          <span>{quote.submittedBy}</span>
          <span title={quote.createdAt}>{formatAgo(quote.createdAt)}</span>
          <span title={quote.lastShownAt ? `Last shown ${formatAgo(quote.lastShownAt)}` : 'Never shown'}>
            shown {quote.shownCount}×
          </span>
        </div>
      </div>
      <div className="quote-acts">
        <button className="modbtn" type="button" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
        <button className="modbtn danger" type="button" disabled={busy} onClick={onDelete}>Remove</button>
      </div>
    </div>
  );
}

export function QuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setQuotes(await getQuotes()), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, 'Could not load quotes')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // Mirrors the command's own lookup closely enough to be useful: number, keyword, or
  // any text. It is a filter over already-loaded quotes, not a second search path.
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return quotes;
    return quotes.filter(quote =>
      String(quote.number) === needle
      || (quote.slug ?? '').includes(needle)
      || quote.text.toLowerCase().includes(needle)
      || quote.submittedBy.toLowerCase().includes(needle));
  }, [quotes, search]);

  const act = (work: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    void work()
      .then(load)
      .then(() => setMessage(success))
      .catch(caught => setError(errorMessage(caught, failure)))
      .finally(() => setBusy(false));
  };

  const add = () => {
    act(
      () => createQuote({
        text: draft.text,
        // An empty keyword field means "no keyword", not an empty one.
        slug: draft.slug.trim() || null,
        submittedBy: draft.submittedBy.trim() || 'operator',
      }).then(() => setDraft(EMPTY_DRAFT)),
      'Quote added.',
      'Could not add the quote',
    );
  };

  const disabled = loading || busy;

  return (
    <div className="quotes-page">
      <SettingsHeader
        section="quotes"
        meta={<div className="set-sub">{quotes.length === 0 ? 'No quotes yet' : `${quotes.length} quote${quotes.length === 1 ? '' : 's'}`}</div>}
      />

      <SettingsStatus message={message} error={error} />

      <div className="quote-add">
        <label className="field settings-wide-field">
          <span>New quote</span>
          <input
            value={draft.text}
            disabled={disabled}
            maxLength={MAX_QUOTE_LENGTH}
            placeholder="I'm hungry for pizza!"
            onChange={event => setDraft({ ...draft, text: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Keyword (optional)</span>
          <input
            value={draft.slug}
            disabled={disabled}
            maxLength={MAX_QUOTE_SLUG_LENGTH}
            placeholder="pizza"
            onChange={event => setDraft({ ...draft, slug: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Submitted by</span>
          <input
            value={draft.submittedBy}
            disabled={disabled}
            maxLength={60}
            placeholder="operator"
            onChange={event => setDraft({ ...draft, submittedBy: event.target.value })}
          />
        </label>
        <button className="modbtn gold" type="button" disabled={disabled || !draft.text.trim()} onClick={add}>
          Add quote
        </button>
      </div>

      {quotes.length > 0 && (
        <label className="field quote-search">
          <span>Find</span>
          <input
            value={search}
            disabled={loading}
            placeholder="Number, keyword, or text"
            onChange={event => setSearch(event.target.value)}
          />
        </label>
      )}

      <div className="quote-list">
        {loading && <div className="command-empty">Loading quotes…</div>}
        {!loading && quotes.length === 0 && (
          <div className="command-empty">
            No quotes yet. Add one above, or wire a viewer command to a “Save a quote” step in Settings → Actions.
          </div>
        )}
        {!loading && quotes.length > 0 && visible.length === 0 && (
          <div className="command-empty">No quote matches “{search}”.</div>
        )}
        {visible.map(quote => (
          <QuoteCard
            key={quote.id}
            quote={quote}
            busy={disabled}
            onSave={next => act(
              () => updateQuote(quote.id, {
                text: next.text,
                slug: next.slug.trim() || null,
                submittedBy: next.submittedBy,
              }),
              `Quote ${quote.number} saved.`,
              'Could not save the quote',
            )}
            onDelete={() => act(
              () => deleteQuote(quote.id),
              `Quote ${quote.number} removed.`,
              'Could not remove the quote',
            )}
          />
        ))}
      </div>
    </div>
  );
}
