import type express from 'express';
import type { Quote, QuoteInput, QuoteUpdate } from '../shared/api';
import { MAX_QUOTE_LENGTH, MAX_QUOTE_SLUG_LENGTH } from '../shared/api';
import { db, isUniqueConstraintError } from './db';
import { handle, HttpRouteError } from './http';

type QuoteRow = {
  id: string;
  number: number;
  slug: string | null;
  text: string;
  submittedBy: string;
  submittedByLogin: string;
  createdAt: string;
  shownCount: number;
  lastShownAt: string | null;
};

const SELECT_COLUMNS = `
  id,
  number,
  slug,
  text,
  submitted_by as submittedBy,
  submitted_by_login as submittedByLogin,
  created_at as createdAt,
  shown_count as shownCount,
  last_shown_at as lastShownAt
`;

const listQuotesRow = db.prepare(`select ${SELECT_COLUMNS} from quotes order by number`);
const getQuoteRow = db.prepare(`select ${SELECT_COLUMNS} from quotes where id = ?`);
const getQuoteByNumberRow = db.prepare(`select ${SELECT_COLUMNS} from quotes where number = ?`);
const getQuoteBySlugRow = db.prepare(`select ${SELECT_COLUMNS} from quotes where slug = ?`);
const searchQuotesRow = db.prepare(`
  select ${SELECT_COLUMNS} from quotes
  where text like ? escape '\\' or (slug is not null and slug like ? escape '\\')
  order by number
`);
const insertQuoteRow = db.prepare(`
  insert into quotes (id, number, slug, text, submitted_by, submitted_by_login, created_at, shown_count, last_shown_at)
  values (?, ?, ?, ?, ?, ?, ?, 0, null)
`);
const updateQuoteRow = db.prepare(`update quotes set slug = ?, text = ?, submitted_by = ? where id = ?`);
const deleteQuoteRow = db.prepare(`delete from quotes where id = ?`);
const countQuotesRow = db.prepare(`select count(*) as total from quotes`);
const recordQuoteShownRow = db.prepare(`
  update quotes set shown_count = shown_count + 1, last_shown_at = ? where id = ?
`);

const readNextNumber = db.prepare(`select next_number as next from quote_sequence where id = 1`);
const bumpNextNumber = db.prepare(`update quote_sequence set next_number = ? where id = 1`);

function toQuote(row: QuoteRow): Quote {
  return {
    id: row.id,
    number: row.number,
    slug: row.slug,
    text: row.text,
    submittedBy: row.submittedBy,
    submittedByLogin: row.submittedByLogin,
    createdAt: row.createdAt,
    shownCount: row.shownCount,
    lastShownAt: row.lastShownAt,
  };
}

/**
 * A slug is a lookup handle typed into chat, so it is matched case-insensitively and
 * stored lowercase. Empty normalizes to null rather than '' so the partial unique
 * index treats "no slug" as absent — otherwise the second slug-less quote would
 * collide with the first.
 */
export function normalizeQuoteSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase().replace(/^[!/]+/, '');
  if (!slug) return null;
  if (slug.length > MAX_QUOTE_SLUG_LENGTH) {
    throw new HttpRouteError(400, `A quote slug must be ${MAX_QUOTE_SLUG_LENGTH} characters or fewer.`);
  }
  // Digits-only would be ambiguous with a quote number, and the number always wins
  // in resolveQuote — so such a slug would be silently unreachable.
  if (/^\d+$/.test(slug)) {
    throw new HttpRouteError(400, 'A quote slug cannot be only digits — that would collide with a quote number.');
  }
  if (/\s/.test(slug)) {
    throw new HttpRouteError(400, 'A quote slug cannot contain spaces.');
  }
  return slug;
}

function normalizeQuoteText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text) throw new HttpRouteError(400, 'A quote needs some text.');
  if (text.length > MAX_QUOTE_LENGTH) {
    throw new HttpRouteError(400, `A quote must be ${MAX_QUOTE_LENGTH} characters or fewer.`);
  }
  return text;
}

export function listQuotes(): Quote[] {
  return (listQuotesRow.all() as QuoteRow[]).map(toQuote);
}

export function getQuote(id: string): Quote | null {
  const row = getQuoteRow.get(id) as QuoteRow | undefined;
  return row ? toQuote(row) : null;
}

export function countQuotes(): number {
  return (countQuotesRow.get() as { total: number }).total;
}

/**
 * Allocating the number and inserting the row share one transaction, so two quotes
 * submitted at once cannot both read the same next_number and collide on the unique
 * index.
 */
const addQuoteTxn = db.transaction((quote: {
  id: string;
  slug: string | null;
  text: string;
  submittedBy: string;
  submittedByLogin: string;
  createdAt: string;
}): number => {
  const number = (readNextNumber.get() as { next: number }).next;
  bumpNextNumber.run(number + 1);
  insertQuoteRow.run(
    quote.id,
    number,
    quote.slug,
    quote.text,
    quote.submittedBy,
    quote.submittedByLogin,
    quote.createdAt,
  );
  return number;
});

export function addQuote(input: QuoteInput): Quote {
  const text = normalizeQuoteText(input.text);
  const slug = normalizeQuoteSlug(input.slug);
  const submittedBy = (typeof input.submittedBy === 'string' ? input.submittedBy.trim() : '').slice(0, 60) || 'unknown';
  const submittedByLogin = (typeof input.submittedByLogin === 'string' ? input.submittedByLogin.trim().toLowerCase() : '').slice(0, 60);
  const id = crypto.randomUUID();

  let number: number;
  try {
    number = addQuoteTxn({ id, slug, text, submittedBy, submittedByLogin, createdAt: new Date().toISOString() });
  } catch (error) {
    if (slug && isUniqueConstraintError(error)) {
      throw new HttpRouteError(409, `A quote with the slug "${slug}" already exists.`);
    }
    throw error;
  }

  const saved = getQuoteByNumberRow.get(number) as QuoteRow | undefined;
  if (!saved) throw new HttpRouteError(500, 'Quote was not saved.');
  return toQuote(saved);
}

export function updateQuote(id: string, update: QuoteUpdate): Quote {
  const existing = getQuote(id);
  if (!existing) throw new HttpRouteError(404, 'Quote not found.');

  const text = update.text === undefined ? existing.text : normalizeQuoteText(update.text);
  const slug = update.slug === undefined ? existing.slug : normalizeQuoteSlug(update.slug);
  const submittedBy = update.submittedBy === undefined
    ? existing.submittedBy
    : (update.submittedBy.trim().slice(0, 60) || 'unknown');

  try {
    updateQuoteRow.run(slug, text, submittedBy, id);
  } catch (error) {
    if (slug && isUniqueConstraintError(error)) {
      throw new HttpRouteError(409, `A quote with the slug "${slug}" already exists.`);
    }
    throw error;
  }

  const saved = getQuote(id);
  if (!saved) throw new HttpRouteError(500, 'Quote was not saved.');
  return saved;
}

export function deleteQuote(id: string): boolean {
  return deleteQuoteRow.run(id).changes > 0;
}

/** LIKE wildcards in viewer-typed keywords are literals, not operators. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

/**
 * Turn whatever a viewer typed after `!quote` into one quote.
 *
 * Precedence is number → exact slug → keyword search, and each tier is tried in full
 * before the next: `!quote 3` must never fall through to "a quote containing 3".
 * An *empty* query is not a failed lookup — it means "any quote", which is what makes
 * a bare `!quote` useful.
 *
 * Returns null when nothing matches. Callers treat that as a skip, not an error: a
 * viewer asking for a quote that isn't there is normal traffic, not a fault.
 */
export function resolveQuote(
  rawQuery: string,
  randomIndex: (length: number) => number = length => Math.floor(Math.random() * length),
): Quote | null {
  const pick = (candidates: QuoteRow[]): Quote | null => {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return toQuote(candidates[0]!);
    const index = Math.min(Math.max(0, Math.floor(randomIndex(candidates.length))), candidates.length - 1);
    return toQuote(candidates[index]!);
  };

  const query = rawQuery.trim();
  if (!query) return pick(listQuotesRow.all() as QuoteRow[]);

  if (/^\d+$/.test(query)) {
    const row = getQuoteByNumberRow.get(Number(query)) as QuoteRow | undefined;
    return row ? toQuote(row) : null;
  }

  const slug = query.toLowerCase().replace(/^[!/]+/, '');
  const bySlug = getQuoteBySlugRow.get(slug) as QuoteRow | undefined;
  if (bySlug) return toQuote(bySlug);

  const pattern = `%${escapeLike(query)}%`;
  return pick(searchQuotesRow.all(pattern, pattern) as QuoteRow[]);
}

/**
 * Bump the shown counter. Called *after* the announcement is delivered, so a Discord
 * outage does not inflate the count for a quote nobody saw.
 */
export function recordQuoteShown(id: string, at: Date = new Date()): void {
  recordQuoteShownRow.run(at.toISOString(), id);
}

export function registerQuoteRoutes(app: express.Express) {
  app.get('/api/quotes', (_request, response) => {
    response.json(listQuotes());
  });

  app.post('/api/quotes', handle((request, response) => {
    const body = (request.body ?? {}) as Partial<QuoteInput>;
    response.status(201).json(addQuote({
      text: typeof body.text === 'string' ? body.text : '',
      slug: body.slug ?? null,
      submittedBy: typeof body.submittedBy === 'string' ? body.submittedBy : 'operator',
      submittedByLogin: typeof body.submittedByLogin === 'string' ? body.submittedByLogin : '',
    }));
  }));

  app.patch('/api/quotes/:id', handle<{ id: string }>((request, response) => {
    const body = (request.body ?? {}) as Partial<QuoteUpdate>;
    const update: QuoteUpdate = {};
    if ('text' in body) update.text = typeof body.text === 'string' ? body.text : '';
    // An explicit null clears the slug; an absent key leaves it alone.
    if ('slug' in body) update.slug = body.slug ?? null;
    if ('submittedBy' in body) update.submittedBy = typeof body.submittedBy === 'string' ? body.submittedBy : '';
    response.json(updateQuote(request.params.id, update));
  }));

  app.delete('/api/quotes/:id', handle<{ id: string }>((request, response) => {
    if (!deleteQuote(request.params.id)) throw new HttpRouteError(404, 'Quote not found.');
    response.status(204).end();
  }));
}
