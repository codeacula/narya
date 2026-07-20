import { beforeEach, describe, expect, test } from 'bun:test';
import { saveAppConfig } from './appConfig';

// The app_config row is a shared singleton, so each test first establishes a
// known baseline (secrets cleared) before asserting the specific behavior.
function baseline() {
  return saveAppConfig({
    twitchChannel: 'basechan',
    twitchClientId: 'base-client-id',
    clearTwitchClientSecret: true,
    obsUrl: 'ws://127.0.0.1:4455',
    clearObsPassword: true,
    obsScenePrefix: 'Scene - ',
    discordClientId: 'disc-id',
    clearDiscordBotToken: true,
    tengwarBaseUrl: 'http://127.0.0.1:8008',
    clearTengwarApiKey: true,
    musicPollIntervalMs: 2000,
    musicPlayerctlPlayer: 'strawberry',
    soundVolume: 0.2,
  }).config;
}

describe('saveAppConfig', () => {
  beforeEach(() => { baseline(); });

  test('absent non-secret fields keep their current value (A14)', () => {
    const { config } = saveAppConfig({});
    expect(config.twitchChannel).toBe('basechan');
    expect(config.twitchClientId).toBe('base-client-id');
    expect(config.obsUrl).toBe('ws://127.0.0.1:4455');
    expect(config.obsScenePrefix).toBe('Scene - ');
    expect(config.musicPlayerctlPlayer).toBe('strawberry');
  });

  // The prefix is a naming convention, not a connection setting: applying it must
  // not tear down a live OBS session mid-stream.
  test('a scene-prefix change does not force an OBS reconnect', () => {
    const { changes } = saveAppConfig({ obsScenePrefix: 'OBS: ' });
    expect(changes.has('obsScenePrefix')).toBe(true);
    expect(changes.has('obs')).toBe(false);
  });

  // "Scene - " ends in a space that separates the convention from the scene's real
  // name. Trimming it would leave every button labelled "- Coding".
  test('preserves a trailing space in the scene prefix', () => {
    expect(saveAppConfig({ obsScenePrefix: 'Scene - ' }).config.obsScenePrefix).toBe('Scene - ');
  });

  test('secret is replaced when provided and kept when absent', () => {
    expect(saveAppConfig({ twitchClientSecret: 'hunter2' }).config.twitchClientSecretConfigured).toBe(true);
    // Absent on the next save → kept.
    expect(saveAppConfig({}).config.twitchClientSecretConfigured).toBe(true);
  });

  test('secret is cleared with the clear flag', () => {
    saveAppConfig({ twitchClientSecret: 'hunter2' });
    expect(saveAppConfig({ clearTwitchClientSecret: true }).config.twitchClientSecretConfigured).toBe(false);
  });

  test('an empty-string secret does not overwrite the stored one', () => {
    saveAppConfig({ twitchClientSecret: 'hunter2' });
    expect(saveAppConfig({ twitchClientSecret: '' }).config.twitchClientSecretConfigured).toBe(true);
  });

  test('reports twitchChannel in the change set only when it changes', () => {
    expect(saveAppConfig({ twitchChannel: 'newchan' }).changes.has('twitchChannel')).toBe(true);
    expect(saveAppConfig({ twitchChannel: 'newchan' }).changes.has('twitchChannel')).toBe(false);
  });

  test('groups OBS field changes under the obs change key', () => {
    const { changes } = saveAppConfig({ obsUrl: 'ws://10.0.0.5:4455' });
    expect(changes.has('obs')).toBe(true);
    expect(changes.has('twitchChannel')).toBe(false);
  });

  test('rejects an invalid channel', () => {
    expect(() => saveAppConfig({ twitchChannel: 'bad name!' })).toThrow('Twitch channel must be');
  });

  test('rejects an OBS URL without a ws scheme', () => {
    expect(() => saveAppConfig({ obsUrl: 'http://127.0.0.1:4455' })).toThrow('OBS WebSocket URL must start with');
  });

  // The Tengwar address is one full base URL with the port already in it, so a
  // Tailscale host is a single field rather than two to keep in sync.
  test('keeps the Tengwar base URL with its port and strips a trailing slash', () => {
    const { config } = saveAppConfig({ tengwarBaseUrl: 'http://100.64.0.5:8008/' });
    expect(config.tengwarBaseUrl).toBe('http://100.64.0.5:8008');
  });

  // Previously only a trailing slash was stripped, so a typo'd scheme was stored
  // happily and surfaced later as an unexplained fetch failure mid-stream.
  test('rejects a Tengwar URL that is not http(s)', () => {
    expect(() => saveAppConfig({ tengwarBaseUrl: 'ws://127.0.0.1:8008' })).toThrow('Tengwar URL must be');
    expect(() => saveAppConfig({ tengwarBaseUrl: 'not a url' })).toThrow('Tengwar URL must be');
  });

  test('the Tengwar API key follows the secret convention', () => {
    expect(saveAppConfig({ tengwarApiKey: 'sekrit' }).config.tengwarApiKeyConfigured).toBe(true);
    // Absent on the next save -> kept; empty string -> also kept.
    expect(saveAppConfig({}).config.tengwarApiKeyConfigured).toBe(true);
    expect(saveAppConfig({ tengwarApiKey: '' }).config.tengwarApiKeyConfigured).toBe(true);
    expect(saveAppConfig({ clearTengwarApiKey: true }).config.tengwarApiKeyConfigured).toBe(false);
  });

  // The key is a secret: it must never come back over the wire, only the boolean.
  test('never returns the Tengwar API key itself', () => {
    const { config } = saveAppConfig({ tengwarApiKey: 'sekrit' });
    expect(JSON.stringify(config)).not.toContain('sekrit');
  });
});
