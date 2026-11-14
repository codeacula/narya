import type express from 'express';
import type { PinnedCard } from '../shared/api';
import { db } from './db';
import { HttpRouteError, handle } from './http';
import { broadcast } from './realtime';

export const MAX_PINNED_TEXT_LENGTH = 200;
// A Twitch message is at most 500 characters; the cap only guards against a longer row.
const MAX_PINNED_QUESTION_LENGTH = 500;

type CardRow = {
  kind: 'question' | 'topic' | null;
  displayName: string;
  text: string;
  messageId: string | null;
  authorLogin: string | null;
};

type MessageRow = {
  username: string;
  displayName: string;
  message: string;
  deletedAt: string | null;
};

const selectCard = db.prepare(`
  select kind, display_name as displayName, text, message_id as messageId, author_login as authorLogin
  from pinned_card where id = 1
`);

const writeCard = db.prepare(`
  insert into pinned_card (id, kind, display_name, text, message_id, author_login, updated_at)
  values (1, ?, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    kind = excluded.kind, display_name = excluded.display_name, text = excluded.text,
    message_id = excluded.message_id, author_login = excluded.author_login, updated_at = excluded.updated_at
`);

const clearCard = db.prepare('delete from pinned_card where id = 1');

// Read from the database, never from the request: a client must not be able to put
// words in a viewer's mouth, or pin a message that moderation has already removed.
const selectMessage = db.prepare(`
  select username, display_name as displayName, message, deleted_at as deletedAt
  from chat_messages where id = ?
`);

// Queried directly rather than through viewerIdentity's isLoginIgnored: flushViewer
// there imports this module, so importing it back would be a cycle between two modules
// that prepare statements at load time.
const selectIgnored = db.prepare('select 1 from ignored_logins where login = ?');

function currentRow(): CardRow | null {
  const row = selectCard.get() as CardRow | null;
  return row && row.kind ? row : null;
}

/**
 * What the overlay may know: kind, display name (questions only) and text.
 *
 * Built field by field, not spread from the row — this reaches the overlay role over
 * both REST and the broadcast, and broadcasts are filtered by event name only, so the
 * message id and author login (and any column added later) must not propagate to a
 * browser source by accident.
 */
export function getPinnedCard(): PinnedCard | null {
  const row = currentRow();
  if (!row) return null;
  return row.kind === 'question'
    ? { kind: 'question', name: row.displayName, text: row.text }
    : { kind: 'topic', text: row.text };
}

function publish(): PinnedCard | null {
  const card = getPinnedCard();
  broadcast('overlay:pinned-card', card);
  return card;
}

/** Trim and cap an operator-typed topic; null when nothing is left. */
export function normalizeTopic(text: string): string | null {
  const trimmed = text.trim().slice(0, MAX_PINNED_TEXT_LENGTH).trim();
  return trimmed || null;
}

/** Pin a viewer's chat message, replacing whatever card is up. */
export function pinChatMessage(messageIdInput: unknown, nowMs = Date.now()): PinnedCard {
  if (typeof messageIdInput !== 'string' || !messageIdInput.trim()) {
    throw new HttpRouteError(400, 'messageId must be a non-empty string');
  }
  const message = selectMessage.get(messageIdInput.trim()) as MessageRow | null;
  if (!message) throw new HttpRouteError(404, 'That chat message was not found');
  // The overlay hides moderated chat; pinning one would put it on stream anyway.
  if (message.deletedAt) throw new HttpRouteError(409, 'That message was removed by moderation and cannot be pinned');
  if (selectIgnored.get(message.username.toLowerCase())) {
    throw new HttpRouteError(409, 'That viewer has been flushed and their messages cannot be pinned');
  }
  const text = message.message.trim().slice(0, MAX_PINNED_QUESTION_LENGTH);
  if (!text) throw new HttpRouteError(409, 'That message has no text to pin');

  writeCard.run('question', message.displayName || message.username, text, messageIdInput.trim(), message.username.toLowerCase(), new Date(nowMs).toISOString());
  return publish() as PinnedCard;
}

/**
 * Pin the operator's own topic. Used by the PUT route and the set_pinned_topic step;
 * the step has already rendered its template, so this only trims, caps and writes.
 *
 * NOTE for later: automatic or LLM pinning of *viewer* messages is deliberately not
 * built. It would go through pinChatMessage (so the moderation and ignore-list checks
 * apply) but needs an operator-approved rule for what may be put on stream unprompted.
 */
export function setPinnedTopic(textInput: unknown, nowMs = Date.now()): PinnedCard {
  if (typeof textInput !== 'string') throw new HttpRouteError(400, 'text must be a string');
  const text = normalizeTopic(textInput);
  if (!text) throw new HttpRouteError(400, 'text must not be empty');
  writeCard.run('topic', '', text, null, null, new Date(nowMs).toISOString());
  return publish() as PinnedCard;
}

/** Remove the card and tell every source. A no-op (no broadcast) when there is none. */
export function clearPinnedCard(): void {
  if (!currentRow()) return;
  clearCard.run();
  publish();
}

// --- moderation ---------------------------------------------------------------
// Called from chat.ts and viewerIdentity.ts at the single place each applies. Topics
// are the operator's own words and are never affected by what happens in chat.

export function clearPinnedCardForMessage(messageId: string): void {
  const row = currentRow();
  if (row?.kind === 'question' && row.messageId === messageId) clearPinnedCard();
}

export function clearPinnedCardForAuthor(login: string): void {
  const row = currentRow();
  if (row?.kind === 'question' && row.authorLogin === login.trim().toLowerCase()) clearPinnedCard();
}

/** A chat clear removes every message, so any pinned question goes with them. */
export function clearPinnedQuestion(): void {
  if (currentRow()?.kind === 'question') clearPinnedCard();
}

export function registerPinnedCardRoutes(app: express.Express) {
  // On OVERLAY_PATHS in auth.ts: the pinned-card overlay seeds itself from it.
  app.get('/api/overlay/pinned-card', (_request, response) => {
    response.json({ card: getPinnedCard() });
  });

  // The writes are deliberately NOT on OVERLAY_PATHS, so the overlay token (GET-only)
  // is refused: a browser source must not be able to put text on every other source.
  app.post('/api/pinned-card/message', handle((request, response) => {
    response.json({ card: pinChatMessage((request.body as { messageId?: unknown } | null)?.messageId) });
  }));

  app.put('/api/pinned-card/topic', handle((request, response) => {
    response.json({ card: setPinnedTopic((request.body as { text?: unknown } | null)?.text) });
  }));

  app.delete('/api/pinned-card', handle((_request, response) => {
    clearPinnedCard();
    response.json({ card: null });
  }));
}
