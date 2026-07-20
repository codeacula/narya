import { describe, expect, test } from 'bun:test';
import { isDashboardTokenRejection, isSendableToken } from './auth';
import { INVALID_DASHBOARD_TOKEN } from '../shared/api';

// Clearing the stored token is destructive: get this predicate wrong in the
// permissive direction and a Twitch-flavoured 401 wipes a perfectly good operator
// token. Only the auth middleware's own code counts.
describe('isDashboardTokenRejection', () => {
  test('recognizes the auth middleware rejecting the token we sent', () => {
    expect(isDashboardTokenRejection(401, { error: 'Unauthorized', code: INVALID_DASHBOARD_TOKEN })).toBe(true);
  });

  test('ignores a route that 401s for its own reasons', () => {
    expect(isDashboardTokenRejection(401, { error: 'Twitch login is required.' })).toBe(false);
    expect(isDashboardTokenRejection(401, { error: 'Twitch bot login is required.' })).toBe(false);
  });

  test('ignores other failures, including the overlay-token 403', () => {
    expect(isDashboardTokenRejection(403, { error: 'Forbidden: overlay token' })).toBe(false);
    expect(isDashboardTokenRejection(500, { error: 'Internal error' })).toBe(false);
    expect(isDashboardTokenRejection(401, null)).toBe(false);
    expect(isDashboardTokenRejection(401, 'Unauthorized')).toBe(false);
  });
});

// A header value must be a ByteString. A stored token with a character above 255 throws
// a fatal, opaque error when attached — breaking every request — so it must be caught
// before it reaches fetch and routed to the recovery screen instead.
describe('isSendableToken', () => {
  test('accepts an ordinary ASCII token', () => {
    expect(isSendableToken('a'.repeat(64))).toBe(true);
    expect(isSendableToken('dev-token_123.ABC')).toBe(true);
  });

  test('accepts the full Latin-1 range a header permits', () => {
    // é is U+00E9 (233) — a legal ByteString code unit, so it must not be rejected.
    expect(isSendableToken('café')).toBe(true);
    expect(isSendableToken('ÿ')).toBe(true);
  });

  test('rejects a token containing an en dash', () => {
    // U+2013 (8211) — the exact character that crashed the operator's dashboard.
    expect(isSendableToken('a'.repeat(490) + '–' + 'b'.repeat(8))).toBe(false);
  });

  test('rejects other smart punctuation and emoji', () => {
    expect(isSendableToken('curly’quote')).toBe(false); // ' right single quote
    expect(isSendableToken('em—dash')).toBe(false); // — em dash
    expect(isSendableToken('\u{1f600}')).toBe(false); // emoji
  });

  test('an empty string is trivially sendable', () => {
    expect(isSendableToken('')).toBe(true);
  });
});
