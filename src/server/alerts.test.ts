import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_ALERT_CONFIG,
  getAlertSettings,
  isAlertEventKind,
  renderTemplate,
  saveAlertSettings,
  testAlert,
} from './alerts';
import { db } from './db';
import { HttpRouteError } from './http';
import { listMediaFiles } from './media';

const KNOWN_AUDIO = listMediaFiles().find(file => file.kind === 'audio')?.src ?? '';

describe('renderTemplate', () => {
  test('substitutes known tokens, coercing numbers', () => {
    expect(renderTemplate('{user} cheered {amount} bits!', { user: 'Sorlus', amount: 500 }))
      .toBe('Sorlus cheered 500 bits!');
  });

  test('leaves unknown tokens intact so a typo is visible on screen', () => {
    expect(renderTemplate('{user} did {mystery}', { user: 'Sorlus' })).toBe('Sorlus did {mystery}');
  });

  test('a template with no tokens is returned unchanged', () => {
    expect(renderTemplate('Welcome!', { user: 'Sorlus' })).toBe('Welcome!');
  });
});

describe('isAlertEventKind', () => {
  test('accepts the five kinds and rejects anything else', () => {
    for (const kind of ['sub', 'gift', 'cheer', 'raid', 'follow']) {
      expect(isAlertEventKind(kind)).toBe(true);
    }
    expect(isAlertEventKind('redeem')).toBe(false);
    expect(isAlertEventKind('')).toBe(false);
    expect(isAlertEventKind(42)).toBe(false);
  });
});

describe('alert_settings persistence', () => {
  beforeEach(() => { db.exec('delete from alert_settings'); });

  test('an unsaved kind falls back to shipped defaults (disabled)', () => {
    const settings = getAlertSettings();
    expect(settings.sub).toEqual(DEFAULT_ALERT_CONFIG.sub);
    expect(settings.follow.enabled).toBe(false);
    expect(settings.updatedAt).toBeNull();
  });

  test('round-trips an enabled config and stamps updatedAt', () => {
    saveAlertSettings({ sub: { enabled: true, template: '{user} subbed!', durationMs: 8000, sound: null, clip: null } });
    const settings = getAlertSettings();
    expect(settings.sub).toEqual({ enabled: true, template: '{user} subbed!', durationMs: 8000, sound: null, clip: null });
    expect(settings.updatedAt).not.toBeNull();
    // Untouched kinds still read as defaults.
    expect(settings.raid).toEqual(DEFAULT_ALERT_CONFIG.raid);
  });

  test('absent fields keep the stored value', () => {
    saveAlertSettings({ cheer: { enabled: true, template: 'A', durationMs: 5000, sound: null, clip: null } });
    saveAlertSettings({ cheer: { template: 'B' } });
    expect(getAlertSettings().cheer).toEqual({ enabled: true, template: 'B', durationMs: 5000, sound: null, clip: null });
  });

  test('clamps duration into the allowed range', () => {
    saveAlertSettings({ raid: { template: 'x', durationMs: 999_999 } });
    expect(getAlertSettings().raid.durationMs).toBe(60_000);
    saveAlertSettings({ raid: { durationMs: 10 } });
    expect(getAlertSettings().raid.durationMs).toBe(1000);
  });

  test('rejects an empty template', () => {
    expect(() => saveAlertSettings({ sub: { template: '   ' } })).toThrow(HttpRouteError);
  });

  test('validates a sound binding and clears it with null', () => {
    if (!KNOWN_AUDIO) return; // no media in a clean checkout
    saveAlertSettings({ gift: { template: 'g', sound: { kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 } } });
    expect(getAlertSettings().gift.sound).toEqual({ kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 });
    saveAlertSettings({ gift: { sound: null } });
    expect(getAlertSettings().gift.sound).toBeNull();
  });

  test('keeps sound and clip independent so both can play together', () => {
    if (!KNOWN_AUDIO) return;
    saveAlertSettings({ raid: { template: 'r', sound: { kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 } } });
    // Updating the clip slot must not disturb the stored sound.
    saveAlertSettings({ raid: { durationMs: 4000 } });
    expect(getAlertSettings().raid.sound).toEqual({ kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 });
  });

  test('forces the sound slot to audio kind, rejecting a mismatched file', () => {
    expect(() => saveAlertSettings({ sub: { template: 's', sound: { kind: 'audio', src: '/sounds/../../.env', volume: 0.5 } } }))
      .toThrow(HttpRouteError);
  });
});

describe('testAlert', () => {
  beforeEach(() => { db.exec('delete from alert_settings'); });

  test('previewing an override does not persist it', () => {
    testAlert('sub', { template: 'unsaved preview', durationMs: 9000 });
    // Nothing was written, so the saved config is still the shipped default.
    expect(getAlertSettings().sub).toEqual(DEFAULT_ALERT_CONFIG.sub);
  });

  test('validates an override before broadcasting', () => {
    expect(() => testAlert('sub', { template: '   ' })).toThrow(HttpRouteError);
    expect(() => testAlert('sub', { sound: { kind: 'audio', src: '/sounds/../../.env', volume: 0.5 } }))
      .toThrow(HttpRouteError);
  });

  test('a bodyless test (no override) previews the saved config', () => {
    saveAlertSettings({ raid: { enabled: true, template: 'saved raid' } });
    // Should not throw; uses the persisted config.
    expect(() => testAlert('raid')).not.toThrow();
  });
});
