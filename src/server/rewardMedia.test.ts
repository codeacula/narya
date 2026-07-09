import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { HttpRouteError } from './http';
import { listMediaFiles } from './media';
import {
  deleteRewardMedia,
  getRewardMedia,
  listRewardMedia,
  normalizeRewardMedia,
  playRewardMedia,
  setRewardMedia,
} from './rewardMedia';

const KNOWN_AUDIO = listMediaFiles().find(file => file.kind === 'audio')?.src ?? '';
// public/clips is gitignored, so a clean checkout has no video to test against.
const KNOWN_VIDEO = listMediaFiles().find(file => file.kind === 'video')?.src ?? '';

describe('normalizeRewardMedia', () => {
  test('accepts a known file with a valid kind', () => {
    expect(normalizeRewardMedia({ kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 }))
      .toEqual({ kind: 'audio', src: KNOWN_AUDIO, volume: 0.5 });
  });

  test('clamps volume into 0..1 and defaults when absent', () => {
    expect(normalizeRewardMedia({ kind: 'audio', src: KNOWN_AUDIO, volume: 9 }).volume).toBe(1);
    expect(normalizeRewardMedia({ kind: 'audio', src: KNOWN_AUDIO, volume: -3 }).volume).toBe(0);
    expect(normalizeRewardMedia({ kind: 'audio', src: KNOWN_AUDIO }).volume).toBe(0.8);
    expect(normalizeRewardMedia({ kind: 'audio', src: KNOWN_AUDIO, volume: NaN }).volume).toBe(0.8);
  });

  test('rejects a src that is not in the media catalog', () => {
    expect(() => normalizeRewardMedia({ kind: 'video', src: '/clips/../../.env' })).toThrow(HttpRouteError);
    expect(() => normalizeRewardMedia({ kind: 'video', src: 'https://evil.example/x.mp4' })).toThrow(HttpRouteError);
  });

  test('rejects a missing src and an unknown kind', () => {
    expect(() => normalizeRewardMedia({ kind: 'audio', src: '' })).toThrow(HttpRouteError);
    expect(() => normalizeRewardMedia({ kind: 'gif', src: KNOWN_AUDIO })).toThrow(HttpRouteError);
  });

  // The overlay picks <video> vs <audio> from the stored kind, so a mismatch
  // would render an mp3 in a video element.
  test('rejects a kind that disagrees with the file', () => {
    expect(() => normalizeRewardMedia({ kind: 'video', src: KNOWN_AUDIO })).toThrow(HttpRouteError);
    if (KNOWN_VIDEO) {
      expect(() => normalizeRewardMedia({ kind: 'audio', src: KNOWN_VIDEO })).toThrow(HttpRouteError);
    }
  });

  test('takes the kind from the catalog, not the client', () => {
    expect(normalizeRewardMedia({ kind: 'audio', src: KNOWN_AUDIO }).kind).toBe('audio');
  });
});

describe('reward_media persistence', () => {
  beforeEach(() => { db.exec('delete from reward_media'); });

  test('round-trips a binding', () => {
    setRewardMedia('reward-1', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
    expect(getRewardMedia('reward-1')).toEqual({ kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
  });

  test('an unbound reward has no media', () => {
    expect(getRewardMedia('nobody')).toBeNull();
  });

  test('setting again replaces rather than duplicating', () => {
    setRewardMedia('reward-1', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
    setRewardMedia('reward-1', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.9 });
    expect(getRewardMedia('reward-1')?.volume).toBe(0.9);
    expect(listRewardMedia().size).toBe(1);
  });

  test('null clears the binding', () => {
    setRewardMedia('reward-1', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
    expect(setRewardMedia('reward-1', null)).toBeNull();
    expect(getRewardMedia('reward-1')).toBeNull();
  });

  test('an invalid binding is rejected without writing a row', () => {
    expect(() => setRewardMedia('reward-1', { kind: 'video', src: '/nope.mp4' })).toThrow(HttpRouteError);
    expect(getRewardMedia('reward-1')).toBeNull();
  });

  test('a kind/src mismatch is rejected without writing a row', () => {
    expect(() => setRewardMedia('reward-1', { kind: 'video', src: KNOWN_AUDIO })).toThrow(HttpRouteError);
    expect(getRewardMedia('reward-1')).toBeNull();
  });

  test('deleteRewardMedia removes the row, so a deleted reward leaves no orphan', () => {
    setRewardMedia('reward-1', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
    deleteRewardMedia('reward-1');
    expect(listRewardMedia().size).toBe(0);
  });

  test('listRewardMedia keys by reward id', () => {
    setRewardMedia('a', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
    setRewardMedia('b', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.6 });
    const all = listRewardMedia();
    expect(all.get('a')?.volume).toBe(0.4);
    expect(all.get('b')?.volume).toBe(0.6);
  });
});

describe('playRewardMedia', () => {
  beforeEach(() => { db.exec('delete from reward_media'); });

  test('a bound reward yields a playback payload carrying the redeemer', () => {
    setRewardMedia('reward-1', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
    const playback = playRewardMedia('reward-1', 'Sorlus');
    expect(playback).toMatchObject({ kind: 'audio', src: KNOWN_AUDIO, volume: 0.4, actor: 'Sorlus' });
    expect(playback?.id).toBeTruthy();
  });

  test('each playback gets a fresh id so the overlay can dedupe replays', () => {
    setRewardMedia('reward-1', { kind: 'audio', src: KNOWN_AUDIO, volume: 0.4 });
    expect(playRewardMedia('reward-1')?.id).not.toBe(playRewardMedia('reward-1')?.id);
  });

  test('an unbound reward plays nothing', () => {
    expect(playRewardMedia('unbound')).toBeNull();
  });
});
