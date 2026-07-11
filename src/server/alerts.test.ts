import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_ALERT_CONFIG,
  getAlertSettings,
  isAlertEventKind,
  renderTemplate,
  saveAlertSettings,
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
    saveAlertSettings({ sub: { enabled: true, template: '{user} subbed!', durationMs: 8000, media: null } });
    const settings = getAlertSettings();
    expect(settings.sub).toEqual({ enabled: true, template: '{user} subbed!', durationMs: 8000, media: null });
    expect(settings.updatedAt).not.toBeNull();
    // Untouched kinds still read as defaults.
    expect(settings.raid).toEqual(DEFAULT_ALERT_CONFIG.raid);
  });

  test('absent fields keep the stored value', () => {
    saveAlertSettings({ cheer: { enabled: true, template: 'A', durationMs: 5000, media: null } });
    saveAlertSettings({ cheer: { template: 'B' } });
    expect(getAlertSettings().cheer).toEqual({ enabled: true, template: 'B', durationMs: 5000, media: null });
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

  test('validates a media binding and clears it with null', () => {
    if (!KNOWN_AUDIO) return; // no media in a clean checkout
    saveAlertSettings({ gift: { template: 'g', media: { kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 } } });
    expect(getAlertSettings().gift.media).toEqual({ kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 });
    saveAlertSettings({ gift: { media: null } });
    expect(getAlertSettings().gift.media).toBeNull();
  });

  test('rejects a media file that is not in the catalog', () => {
    expect(() => saveAlertSettings({ sub: { template: 's', media: { kind: 'audio', src: '/sounds/../../.env', volume: 0.5 } } }))
      .toThrow(HttpRouteError);
  });
});
