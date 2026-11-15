import { describe, expect, test } from 'bun:test';
import type { ChatMessage, ChatModerationEvent } from '../shared/api';
import { applyModeration, overlayChatRowClass, overlayChatRows } from './chat';

function message(id: string, username: string): ChatMessage {
  return { id, username, message: 'hi', deletedAt: null, deletedReason: null } as unknown as ChatMessage;
}

const base = { channel: 'c', deletedAt: '2026-11-14T12:00:00.000Z', deletedReason: 'r' };

describe('applyModeration', () => {
  const rows = [message('1', 'Quiet'), message('2', 'other')];

  test('a user-scoped event (ban, flush) hides every row from that user, case-insensitively', () => {
    const next = applyModeration(rows, { ...base, type: 'user.ban', username: 'quiet' } as ChatModerationEvent);
    expect(next.map(m => Boolean(m.deletedAt))).toEqual([true, false]);
  });

  test('a message event hides only that row', () => {
    const next = applyModeration(rows, { ...base, type: 'message.deleted', messageId: '2' } as ChatModerationEvent);
    expect(next.map(m => Boolean(m.deletedAt))).toEqual([false, true]);
  });
});

describe('overlay chat rows', () => {
  const row = (id: string, extra: Partial<ChatMessage> = {}) =>
    ({ ...message(id, 'u'), ...extra }) as ChatMessage;

  test('a moderated message is dropped from the overlay, not marked', () => {
    const rows = overlayChatRows([row('1'), row('2', { deletedAt: '2026-11-14T12:00:00.000Z' }), row('3')]);
    expect(rows.map(m => m.id)).toEqual(['3', '1']);
  });

  test('rows come out newest first for the column-reverse layout, without mutating the input', () => {
    const input = [row('1'), row('2'), row('3')];
    expect(overlayChatRows(input).map(m => m.id)).toEqual(['3', '2', '1']);
    expect(input.map(m => m.id)).toEqual(['1', '2', '3']);
  });

  test('row classes carry only the signals the overlay styles', () => {
    expect(overlayChatRowClass(row('1'), false)).toBe('chat-message');
    expect(overlayChatRowClass(row('1', { isFirstTimer: true, isExiting: true }), true))
      .toBe('chat-message first-time mention exiting');
    // A moderated row never reaches the overlay, so it never gets a "moderated" class.
    expect(overlayChatRowClass(row('1', { deletedAt: '2026-11-14T12:00:00.000Z' }), false)).toBe('chat-message');
  });
});
