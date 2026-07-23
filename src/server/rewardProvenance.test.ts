import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { createApp } from './apps';
import { clearRewardSource, ensureManualProvenance, getRewardSource, setRewardSource } from './rewardProvenance';

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
});
