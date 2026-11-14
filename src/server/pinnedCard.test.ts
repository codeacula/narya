import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { HttpRouteError } from './http';
import {
  MAX_PINNED_TEXT_LENGTH,
  clearPinnedCard,
  getPinnedCard,
  pinChatMessage,
  setPinnedTopic,
} from './pinnedCard';
import { handleBan, handleChatClear, handleMessageDeleted, handleTimeout } from './chat';
import { flushViewer } from './viewerIdentity';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HttpRouteError ? error.status : -1;
  }
}

function seedMessage(id: string, username: string, text: string, deletedAt: string | null = null) {
  db.prepare(`
    insert into chat_messages (id, channel, username, display_name, message, received_at, deleted_at)
    values (?, 'codeacula', ?, ?, ?, ?, ?)
  `).run(id, username, username.toUpperCase(), text, '2026-11-14T11:59:00.000Z', deletedAt);
}

// The moderation handlers take an ircv3 message only to read tags from it.
const FAKE_MSG = { tags: new Map<string, string>() } as never;

beforeEach(() => {
  db.exec('delete from pinned_card');
  db.exec('delete from chat_messages');
  db.exec('delete from chat_events');
  db.exec('delete from ignored_logins');
  seedMessage('m1', 'quietorbit', 'How do you decide when a side project is done?');
  seedMessage('m2', 'other', 'Another question entirely');
});

describe('pinned card state', () => {
  test('starts empty', () => {
    expect(getPinnedCard()).toBeNull();
  });

  test('pins a message using the stored name and text, not anything from the caller', () => {
    pinChatMessage('m1', NOW);
    expect(getPinnedCard()).toEqual({
      kind: 'question',
      name: 'QUIETORBIT',
      text: 'How do you decide when a side project is done?',
    });
  });

  test('the overlay payload carries no message id or author login', () => {
    pinChatMessage('m1', NOW);
    expect(Object.keys(getPinnedCard()!).sort()).toEqual(['kind', 'name', 'text']);
    expect(JSON.stringify(getPinnedCard())).not.toContain('m1');
    setPinnedTopic('Refactoring', NOW);
    expect(Object.keys(getPinnedCard()!).sort()).toEqual(['kind', 'text']);
  });

  test('a topic and a question share one slot', () => {
    setPinnedTopic('  Refactoring  ', NOW);
    expect(getPinnedCard()).toEqual({ kind: 'topic', text: 'Refactoring' });
    pinChatMessage('m2', NOW);
    expect(getPinnedCard()?.kind).toBe('question');
    setPinnedTopic('Back to topics', NOW);
    expect(getPinnedCard()).toEqual({ kind: 'topic', text: 'Back to topics' });
  });

  test('topics are trimmed, non-empty and capped', () => {
    expect(statusOf(() => setPinnedTopic('   ', NOW))).toBe(400);
    expect(statusOf(() => setPinnedTopic(42 as never, NOW))).toBe(400);
    setPinnedTopic('x'.repeat(MAX_PINNED_TEXT_LENGTH + 50), NOW);
    expect((getPinnedCard() as { text: string }).text).toHaveLength(MAX_PINNED_TEXT_LENGTH);
  });

  test('refuses a missing, soft-deleted or flushed-author message', () => {
    expect(statusOf(() => pinChatMessage('nope', NOW))).toBe(404);
    expect(statusOf(() => pinChatMessage('', NOW))).toBe(400);
    seedMessage('m3', 'removed', 'bad', '2026-11-14T11:59:30.000Z');
    expect(statusOf(() => pinChatMessage('m3', NOW))).toBe(409);
    db.prepare("insert into ignored_logins (login, reason, created_at) values ('other', '', ?)").run('2026-11-14T00:00:00.000Z');
    expect(statusOf(() => pinChatMessage('m2', NOW))).toBe(409);
    expect(getPinnedCard()).toBeNull();
  });

  test('clear removes either kind', () => {
    pinChatMessage('m1', NOW);
    clearPinnedCard();
    expect(getPinnedCard()).toBeNull();
    setPinnedTopic('hi', NOW);
    clearPinnedCard();
    expect(getPinnedCard()).toBeNull();
  });
});

describe('moderation clears the card', () => {
  test('deleting the pinned message clears it; deleting another does not', () => {
    pinChatMessage('m1', NOW);
    handleMessageDeleted('#codeacula', 'm2', 'other', undefined, FAKE_MSG);
    expect(getPinnedCard()?.kind).toBe('question');
    handleMessageDeleted('#codeacula', 'm1', 'quietorbit', undefined, FAKE_MSG);
    expect(getPinnedCard()).toBeNull();
  });

  test('timing out or banning the author clears it; another viewer does not', () => {
    pinChatMessage('m1', NOW);
    handleTimeout('#codeacula', 'other', 60, FAKE_MSG);
    expect(getPinnedCard()?.kind).toBe('question');
    handleTimeout('#codeacula', 'QuietOrbit', 60, FAKE_MSG);
    expect(getPinnedCard()).toBeNull();

    // The timeout soft-deleted m1, so a fresh message is needed to pin again.
    seedMessage('m4', 'quietorbit', 'A second question');
    pinChatMessage('m4', NOW);
    handleBan('#codeacula', 'quietorbit', FAKE_MSG);
    expect(getPinnedCard()).toBeNull();
  });

  test('a chat clear removes a pinned question', () => {
    pinChatMessage('m1', NOW);
    handleChatClear('#codeacula');
    expect(getPinnedCard()).toBeNull();
  });

  test('flushing the author clears it', () => {
    pinChatMessage('m1', NOW);
    flushViewer('other');
    expect(getPinnedCard()?.kind).toBe('question');
    flushViewer('quietorbit');
    expect(getPinnedCard()).toBeNull();
  });

  test('topics are untouched by chat moderation', () => {
    setPinnedTopic('Refactoring', NOW);
    handleChatClear('#codeacula');
    handleBan('#codeacula', 'quietorbit', FAKE_MSG);
    handleMessageDeleted('#codeacula', 'm1', 'quietorbit', undefined, FAKE_MSG);
    flushViewer('quietorbit');
    expect(getPinnedCard()).toEqual({ kind: 'topic', text: 'Refactoring' });
  });

  // A set_pinned_topic step can render viewer text ({input}), so a topic an Action set
  // on a viewer's behalf must come down with that viewer like a question does.
  test('a topic set on a viewer\'s behalf is cleared by their timeout, ban or flush', () => {
    setPinnedTopic('viewer words', NOW, 'QuietOrbit');
    handleTimeout('#codeacula', 'other', 60, FAKE_MSG);
    expect(getPinnedCard()).toEqual({ kind: 'topic', text: 'viewer words' });
    handleTimeout('#codeacula', 'quietorbit', 60, FAKE_MSG);
    expect(getPinnedCard()).toBeNull();

    setPinnedTopic('viewer words', NOW, 'quietorbit');
    handleBan('#codeacula', 'quietorbit', FAKE_MSG);
    expect(getPinnedCard()).toBeNull();

    setPinnedTopic('viewer words', NOW, 'quietorbit');
    flushViewer('quietorbit');
    expect(getPinnedCard()).toBeNull();
  });

  test('a chat clear removes a viewer-derived topic but not an operator one', () => {
    setPinnedTopic('viewer words', NOW, 'quietorbit');
    handleChatClear('#codeacula');
    expect(getPinnedCard()).toBeNull();
  });

  test('a flushed viewer cannot put a topic up', () => {
    flushViewer('quietorbit');
    expect(statusOf(() => setPinnedTopic('viewer words', NOW, 'quietorbit'))).toBe(409);
    expect(getPinnedCard()).toBeNull();
  });
});
