import { describe, expect, test } from 'bun:test';
import { parseJsonColumn, readResponseError } from './http';

describe('readResponseError', () => {
  test('returns message from a JSON error body', async () => {
    const response = new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
    expect(await readResponseError(response, 'fallback')).toBe('boom');
  });

  test('returns error field when message is absent', async () => {
    const response = new Response(JSON.stringify({ error: 'nope' }), { status: 400 });
    expect(await readResponseError(response, 'fallback')).toBe('nope');
  });

  test('returns the trimmed plain-text body when not JSON (A1 regression)', async () => {
    const response = new Response('  <html>502 Bad Gateway</html>  ', { status: 502 });
    expect(await readResponseError(response, 'fallback')).toBe('<html>502 Bad Gateway</html>');
  });

  test('falls back when the body is empty', async () => {
    const response = new Response('', { status: 503 });
    expect(await readResponseError(response, 'fallback')).toBe('fallback');
  });
});

describe('parseJsonColumn', () => {
  test('parses a JSON value', () => {
    expect(parseJsonColumn<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  test('returns null for null input', () => {
    expect(parseJsonColumn('')).toBeNull();
    expect(parseJsonColumn(null)).toBeNull();
  });

  test('returns null for malformed JSON instead of throwing', () => {
    expect(parseJsonColumn('{not json')).toBeNull();
  });
});
