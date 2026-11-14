import { describe, expect, test } from 'bun:test';
import type { ChatMessage, ChatModerationEvent } from '../shared/api';
import { applyModeration } from './chat';

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
