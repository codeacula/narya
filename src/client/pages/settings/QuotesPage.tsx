import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirm } from '../../ui/confirm';
import type { Quote } from '../../../shared/api';
import { MAX_QUOTE_LENGTH, MAX_QUOTE_SLUG_LENGTH } from '../../../shared/api';
import { createQuote, deleteQuote, getQuotes, updateQuote } from '../../services/dashboard';
import { ListUnavailable, SettingsHeader, SettingsStatus } from './shared';
import { listFace } from './listState';
import { errorMessage } from '../../errors';
import { formatAgo } from '../../../shared/time';
import { useDirtyGuard, useOpenIds } from '../../ui/dirtyGuard';
import { draftsDiffer, keepOpenInView } from '../../ui/dirtyGuardLogic';
import { EmptyState } from '../../ui/emptyState';

type Draft = { text: string; slug: string; submittedBy: string };

const EMPTY_DRAFT: Draft = { text: '', slug: '', submittedBy: '' };

/**
 * One quote. Editing is inline and local until saved, so a refresh caused by another
 * card's save cannot discard edits in progress here — the same reason the category
 * cards keep their own draft state. Because the draft lives here, the card reports
 * when it is editing (`setOpen`) and the page keeps it in the list past the Find
 * filter: unmounting it would drop the draft without asking.
 */
function QuoteCard({ quote, busy, setOpen, onSave, onDelete }: {
  quote: Quote;
  busy: boolean;
  setOpen: (id: string, open: boolean) => void;
  onSave: (draft: Draft) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  useEffect(() => { setOpen(quote.id, editing); }, [setOpen, quote.id, editing]);
  useEffect(() => () => setOpen(quote.id, false), [setOpen, quote.id]);
  const [draft, setDraft] = useState<Draft>({
    text: quote.text,
    slug: quote.slug ?? '',
    submittedBy: quote.submittedBy,
  });

  // Compared against the quote as it stands now, so a save (which refreshes `quote`)
  // leaves the card clean without anything here having to notice.
  useDirtyGuard(
    editing && draftsDiffer(draft, { text: quote.text, slug: quote.slug ?? '', submittedBy: quote.submittedBy }),
    `quote #${quote.number}`,
  );

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
  const confirm = useConfirm();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed load is not an empty list (listState.ts); the next successful load clears it.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const load = useCallback(async () => {
    setQuotes(await getQuotes());
    setLoadFailed(false);
  }, []);

  useDirtyGuard(draftsDiffer(draft, EMPTY_DRAFT), 'the new quote');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Cleared so a retry that fails the same way still changes the alert, and is
    // announced again rather than leaving the reader with nothing.
    setError(null);
    void load()
      .then(() => { if (!cancelled) setError(null); })
      .catch(caught => {
        if (cancelled) return;
        setLoadFailed(true);
        setError(errorMessage(caught, 'Could not load quotes'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load, loadAttempt]);

  // Mirrors the command's own lookup closely enough to be useful: number, keyword, or
  // any text. It is a filter over already-loaded quotes, not a second search path.
  // A quote being edited stays listed whatever Find says (keepOpenInView).
  const { open: editingIds, setOpen } = useOpenIds<string>();
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return quotes;
    return keepOpenInView(quotes, quote =>
      String(quote.number) === needle
      || (quote.slug ?? '').includes(needle)
      || quote.text.toLowerCase().includes(needle)
      || quote.submittedBy.toLowerCase().includes(needle), editingIds, quote => quote.id);
  }, [quotes, search, editingIds]);

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
  const face = listFace({ loading, loadFailed, count: quotes.length });

  return (
    <>
      <SettingsHeader
        section="quotes"
        counts={loadFailed ? undefined : [{ value: quotes.length, one: 'quote' }]}
      />

      {/* The header sits outside the column so its spacing is the shell's, not this
          column's gap — every section's header has to measure the same. */}
      <div className="quotes-page">
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
          {loading && <EmptyState title="Loading quotes…" />}
          {face === 'unavailable' && <ListUnavailable title="Quotes unavailable" onRetry={() => setLoadAttempt(n => n + 1)} retrying={loading} />}
          {face === 'empty' && (
            <EmptyState title="No quotes yet">
              Add one above, or wire a viewer command to a “Save a quote” step in Settings → Actions.
            </EmptyState>
          )}
          {!loading && quotes.length > 0 && visible.length === 0 && (
            <EmptyState title="No matching quotes">Nothing matches “{search}”.</EmptyState>
          )}
          {visible.map(quote => (
            <QuoteCard
              key={quote.id}
              quote={quote}
              busy={disabled}
              setOpen={setOpen}
              onSave={next => act(
                () => updateQuote(quote.id, {
                  text: next.text,
                  slug: next.slug.trim() || null,
                  submittedBy: next.submittedBy,
                }),
                `Quote ${quote.number} saved.`,
                'Could not save the quote',
              )}
              onDelete={async () => {
                // quote_sequence never reuses a number, so removing quote 12 retires 12
                // for good while it is still circulating in Discord and screenshots.
                const ok = await confirm({
                  title: `Remove quote ${quote.number}?`,
                  body: `Number ${quote.number} is retired for good and cannot be reissued.`,
                  confirmLabel: 'Remove quote',
                  tone: 'danger',
                });
                if (!ok) return;
                act(
                  () => deleteQuote(quote.id),
                  `Quote ${quote.number} removed.`,
                  'Could not remove the quote',
                );
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
