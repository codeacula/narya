import { describe, expect, test } from 'bun:test';
import { isTerminalDiscordFailure } from './goLive';
import { HttpRouteError } from './http';
import {
  clearSessionAnnounceError,
  getOrStartStreamSession,
  recordSessionAnnounceError,
} from './streamSession';

function startSession() {
  return getOrStartStreamSession(`twitch:${crypto.randomUUID()}`, new Date().toISOString());
}

describe('isTerminalDiscordFailure', () => {
  test('treats config and permission failures as terminal', () => {
    // Bad bot token, missing Send Messages, deleted channel, message Discord rejects.
    expect(isTerminalDiscordFailure(new HttpRouteError(401, 'Unauthorized'))).toBe(true);
    expect(isTerminalDiscordFailure(new HttpRouteError(403, 'Missing Permissions'))).toBe(true);
    expect(isTerminalDiscordFailure(new HttpRouteError(404, 'Unknown Channel'))).toBe(true);
    expect(isTerminalDiscordFailure(new HttpRouteError(400, 'Cannot send an empty message'))).toBe(true);
  });

  test('treats rate limits and outages as retryable', () => {
    expect(isTerminalDiscordFailure(new HttpRouteError(429, 'Discord rate limit hit.'))).toBe(false);
    expect(isTerminalDiscordFailure(new HttpRouteError(502, 'Discord request failed (500).'))).toBe(false);
  });

  test('treats a raw network failure as retryable', () => {
    // fetch() rejects with a TypeError, which never reaches HttpRouteError.
    expect(isTerminalDiscordFailure(new TypeError('fetch failed'))).toBe(false);
  });
});

describe('session announce state', () => {
  test('a transient failure burns an attempt but leaves the session retryable', () => {
    const session = startSession();
    expect(session.discordAnnounceAttempts).toBe(0);
    expect(session.discordAnnounceTerminal).toBe(0);

    recordSessionAnnounceError(session.id, 'Discord rate limit hit.', false);

    const after = getOrStartStreamSession(session.source, session.startedAt);
    expect(after.discordAnnounceAttempts).toBe(1);
    // Not terminal: a later reconnect is allowed to try again, where the old code
    // suppressed every future attempt as soon as any error was persisted.
    expect(after.discordAnnounceTerminal).toBe(0);
  });

  test('a terminal failure marks the session so it stops retrying', () => {
    const session = startSession();
    recordSessionAnnounceError(session.id, 'Missing Permissions', true);

    const after = getOrStartStreamSession(session.source, session.startedAt);
    expect(after.discordAnnounceTerminal).toBe(1);
  });

  test('a successful announcement clears the failure state', () => {
    const session = startSession();
    recordSessionAnnounceError(session.id, 'Discord rate limit hit.', false);
    clearSessionAnnounceError(session.id);

    const after = getOrStartStreamSession(session.source, session.startedAt);
    expect(after.discordAnnounceError).toBeNull();
    expect(after.discordAnnounceAttempts).toBe(0);
  });
});
