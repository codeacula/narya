import { describe, expect, test } from 'bun:test';
import { isDashboardTokenRejection } from './auth';
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
