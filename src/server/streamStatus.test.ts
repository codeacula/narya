import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getStreamStatus, saveStreamStatus } from './streamStatus';

describe('stream status', () => {
  beforeEach(() => {
    db.exec('delete from stream_status');
  });

  test('defaults to empty text when unset', () => {
    expect(getStreamStatus()).toEqual({ text: '', updatedAt: '' });
  });

  test('saving stores and returns the text with a timestamp', () => {
    const saved = saveStreamStatus({ text: 'brb in 5' });
    expect(saved.text).toBe('brb in 5');
    expect(saved.updatedAt).not.toBe('');
    expect(getStreamStatus().text).toBe('brb in 5');
  });

  test('saving again replaces the prior value', () => {
    saveStreamStatus({ text: 'first' });
    saveStreamStatus({ text: 'second' });
    expect(getStreamStatus().text).toBe('second');
  });

  test('text is trimmed', () => {
    expect(saveStreamStatus({ text: '   spaced   ' }).text).toBe('spaced');
  });

  test('non-string or missing text becomes empty', () => {
    expect(saveStreamStatus({ text: 42 }).text).toBe('');
    expect(saveStreamStatus({}).text).toBe('');
    expect(saveStreamStatus(null).text).toBe('');
  });

  test('text is capped at 280 characters', () => {
    const saved = saveStreamStatus({ text: 'a'.repeat(400) });
    expect(saved.text.length).toBe(280);
  });
});
