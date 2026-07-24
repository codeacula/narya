import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { createApp } from './apps';
import {
  clearRewardSource,
  ensureManualProvenance,
  findRewardByExternalRef,
  getRewardSource,
  listRewardIdsBySource,
  ownsReward,
  rewardCountsBySource,
  setRewardSource,
  setRewardSourceWithRef,
} from './rewardProvenance';

describe('reward provenance', () => {
  beforeEach(() => {
    db.prepare('delete from reward_provenance').run();
    db.prepare('delete from apps').run();
  });

  test('join miss is null (never a fabricated manual)', () => {
    expect(getRewardSource('r1')).toBeNull();
  });

  test('setRewardSource validates against known sources', () => {
    expect(() => setRewardSource('r1', 'ghost')).toThrow();
    createApp('pztmi');
    setRewardSource('r1', 'pztmi');
    expect(getRewardSource('r1')).toBe('pztmi');
    setRewardSource('r1', 'manual'); // upsert overwrites
    expect(getRewardSource('r1')).toBe('manual');
  });

  test('ensureManualProvenance fills unknown ids but never overwrites an existing source', () => {
    createApp('pztmi');
    setRewardSource('r1', 'pztmi');
    ensureManualProvenance('r1');           // r1 already sourced -> unchanged
    ensureManualProvenance('r2');           // r2 unknown -> manual
    expect(getRewardSource('r1')).toBe('pztmi');
    expect(getRewardSource('r2')).toBe('manual');
  });

  test('clearRewardSource removes the row', () => {
    setRewardSource('r1', 'manual');
    clearRewardSource('r1');
    expect(getRewardSource('r1')).toBeNull();
  });

  describe('ownsReward', () => {
    test('is true only for the exact (reward_id, source) pair', () => {
      createApp('pztmi');
      createApp('obsbot');
      setRewardSource('r1', 'pztmi');

      expect(ownsReward('r1', 'pztmi')).toBe(true);
    });

    test('is false for another app\'s source', () => {
      createApp('pztmi');
      createApp('obsbot');
      setRewardSource('r1', 'pztmi');

      expect(ownsReward('r1', 'obsbot')).toBe(false);
    });

    test('is false for manual when the reward is actually owned by an app', () => {
      createApp('pztmi');
      setRewardSource('r1', 'pztmi');

      expect(ownsReward('r1', 'manual')).toBe(false);
    });

    test('is false for an unknown reward id (a missing row is never "owned")', () => {
      expect(ownsReward('does-not-exist', 'pztmi')).toBe(false);
      expect(ownsReward('does-not-exist', 'manual')).toBe(false);
      expect(ownsReward('does-not-exist', 'narya')).toBe(false);
    });
  });

  describe('findRewardByExternalRef', () => {
    test('scopes by source — the same external_ref under two sources resolves independently', () => {
      createApp('pztmi');
      createApp('obsbot');
      setRewardSourceWithRef('r1', 'pztmi', 'shared-ref');
      setRewardSourceWithRef('r2', 'obsbot', 'shared-ref');

      expect(findRewardByExternalRef('pztmi', 'shared-ref')).toBe('r1');
      expect(findRewardByExternalRef('obsbot', 'shared-ref')).toBe('r2');
    });

    test('returns null on a miss', () => {
      expect(findRewardByExternalRef('pztmi', 'never-written')).toBeNull();
    });

    test('rejects a second reward id claiming the same (source, external_ref) pair', () => {
      createApp('pztmi');
      setRewardSourceWithRef('r1', 'pztmi', 'dup-ref');

      expect(() => setRewardSourceWithRef('r2', 'pztmi', 'dup-ref')).toThrow();
    });
  });

  describe('listRewardIdsBySource', () => {
    test('returns only that source\'s ids', () => {
      createApp('pztmi');
      createApp('obsbot');
      setRewardSource('r1', 'pztmi');
      setRewardSource('r2', 'pztmi');
      setRewardSource('r3', 'obsbot');
      setRewardSource('r4', 'manual');

      expect(listRewardIdsBySource('pztmi').sort()).toEqual(['r1', 'r2']);
      expect(listRewardIdsBySource('obsbot')).toEqual(['r3']);
      expect(listRewardIdsBySource('narya')).toEqual([]);
    });
  });

  describe('rewardCountsBySource', () => {
    test('counts correctly across manual, narya, and two apps, omitting none', () => {
      createApp('pztmi');
      createApp('obsbot');
      setRewardSource('r1', 'manual');
      setRewardSource('r2', 'manual');
      setRewardSource('r3', 'narya');
      setRewardSource('r4', 'pztmi');
      setRewardSource('r5', 'pztmi');
      setRewardSource('r6', 'pztmi');
      setRewardSource('r7', 'obsbot');

      expect(rewardCountsBySource()).toEqual({
        manual: 2,
        narya: 1,
        pztmi: 3,
        obsbot: 1,
      });
    });
  });
});
