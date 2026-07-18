import { beforeEach, describe, expect, test } from 'bun:test';
import { appConfig, getAppConfig, reloadAppConfig, saveAppConfig } from './appConfig';
import { db } from './db';
import {
  clearTwitchIdentity,
  getAuthenticatedTwitchLogin,
  resetTwitchIdentityCache,
  setTwitchIdentity,
} from './twitchIdentity';

function signIn(login: string, userId = '1234') {
  // setTwitchIdentity updates the token row, so a login has to have happened first.
  db.prepare(`
    insert into twitch_oauth (provider, access_token, refresh_token, scopes_json, token_type, expires_at, updated_at)
    values ('twitch', 'token', 'refresh', '[]', 'bearer', null, ?)
    on conflict(provider) do update set updated_at = excluded.updated_at
  `).run(new Date().toISOString());
  return setTwitchIdentity('user', { userId, login });
}

describe('channel derived from the Twitch login', () => {
  beforeEach(() => {
    db.prepare(`delete from twitch_oauth`).run();
    resetTwitchIdentityCache();
    saveAppConfig({ twitchChannel: '' });
    reloadAppConfig();
  });

  test('with nobody signed in and no override, there is no channel', () => {
    expect(getAuthenticatedTwitchLogin()).toBe('');
    expect(appConfig.twitchChannel).toBe('');
  });

  test('signing in supplies the channel without the operator typing it', () => {
    signIn('codeacula');
    expect(appConfig.twitchChannel).toBe('codeacula');
  });

  test('the login is normalized to lowercase', () => {
    signIn('CodeAcula');
    expect(appConfig.twitchChannel).toBe('codeacula');
  });

  test('a stored channel overrides the signed-in login', () => {
    signIn('codeacula');
    saveAppConfig({ twitchChannel: 'someotherchannel' });
    expect(appConfig.twitchChannel).toBe('someotherchannel');
  });

  test('clearing the override falls back to the login again', () => {
    signIn('codeacula');
    saveAppConfig({ twitchChannel: 'someotherchannel' });
    saveAppConfig({ twitchChannel: '' });
    expect(appConfig.twitchChannel).toBe('codeacula');
  });

  test('signing out drops the derived channel', () => {
    signIn('codeacula');
    db.prepare(`delete from twitch_oauth where provider = 'twitch'`).run();
    clearTwitchIdentity('user');
    expect(appConfig.twitchChannel).toBe('');
  });

  // The Settings form binds to the stored value. If toPublic leaked the derived
  // login, saving the form unchanged would freeze it into a permanent override —
  // and a later re-login under a different account would silently keep the old one.
  test('the public config reports the stored override and the login separately', () => {
    signIn('codeacula');
    const withoutOverride = getAppConfig();
    expect(withoutOverride.twitchChannel).toBe('');
    expect(withoutOverride.twitchChannelFromLogin).toBe('codeacula');

    saveAppConfig({ twitchChannel: 'someotherchannel' });
    const withOverride = getAppConfig();
    expect(withOverride.twitchChannel).toBe('someotherchannel');
    expect(withOverride.twitchChannelFromLogin).toBe('codeacula');
  });

  test('re-signing-in under the same login reports no channel change', () => {
    expect(signIn('codeacula')).toBe(true);
    expect(signIn('codeacula')).toBe(false);
    expect(signIn('someoneelse')).toBe(true);
  });
});
