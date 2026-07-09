import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../db';
import { handleEventSubNotification, resetSubMergeState } from '../eventsub';
import { RuntimeState } from '../runtime';
import { endActiveStreamSession, getOrStartStreamSession } from '../streamSession';
import { getSessionShoutouts } from './status';

function startSession(source: string) {
  endActiveStreamSession();
  db.exec('delete from stream_events');
  db.exec('delete from stream_sessions');
  return getOrStartStreamSession(source, new Date().toISOString());
}

async function emit(type: string, event: Record<string, unknown>) {
  await handleEventSubNotification(new RuntimeState(), type, event);
}

describe('getSessionShoutouts', () => {
  beforeEach(() => { resetSubMergeState(); });

  test('returns nobody when no session is active', async () => {
    startSession('test-none');
    endActiveStreamSession();
    await emit('channel.follow', { user_name: 'Ghost' });
    expect(getSessionShoutouts()).toEqual([]);
  });

  test('collects the people worth thanking this session', async () => {
    startSession('test-collect');
    await emit('channel.follow', { user_name: 'Jane' });
    await emit('channel.cheer', { user_name: 'Bob', bits: 100 });
    await emit('channel.raid', { from_broadcaster_user_name: 'Sorlus', viewers: 8 });

    const actors = getSessionShoutouts().map(s => s.actor).sort();
    expect(actors).toEqual(['Bob', 'Jane', 'Sorlus']);
  });

  test('groups every kind a person contributed onto one entry', async () => {
    startSession('test-group');
    await emit('channel.follow', { user_name: 'Jane' });
    await emit('channel.cheer', { user_name: 'Jane', bits: 500 });

    const shoutouts = getSessionShoutouts();
    expect(shoutouts).toHaveLength(1);
    expect(shoutouts[0]?.actor).toBe('Jane');
    expect(shoutouts[0]?.kinds.sort()).toEqual(['cheer', 'follow']);
    // The latest activity wins the detail line.
    expect(shoutouts[0]?.detail).toBe('cheered 500 bits');
  });

  test('excludes ad breaks', async () => {
    startSession('test-ads');
    await emit('channel.ad_break.begin', { duration_seconds: 180, started_at: new Date().toISOString() });
    expect(getSessionShoutouts()).toEqual([]);
  });

  test('excludes events recorded during an earlier session', async () => {
    startSession('test-earlier');
    await emit('channel.follow', { user_name: 'OldFan' });
    endActiveStreamSession();

    getOrStartStreamSession('test-later', new Date().toISOString());
    await emit('channel.follow', { user_name: 'NewFan' });

    expect(getSessionShoutouts().map(s => s.actor)).toEqual(['NewFan']);
  });

  test('a resub merged in place still counts once', async () => {
    startSession('test-resub');
    const userId = 'u-1';
    await emit('channel.subscribe', { user_id: userId, user_name: 'Sorlus', tier: '1000', is_gift: false });
    await emit('channel.subscription.message', { user_id: userId, user_name: 'Sorlus', tier: '1000', cumulative_months: 3 });

    const shoutouts = getSessionShoutouts();
    expect(shoutouts).toHaveLength(1);
    expect(shoutouts[0]?.kinds).toEqual(['sub']);
    expect(shoutouts[0]?.detail).toBe('resub · Tier 1 · 3 months');
  });
});
