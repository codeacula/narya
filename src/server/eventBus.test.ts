import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const published: Array<{ key: string; value: string }> = [];
mock.module('./redis', () => ({
  redisPublish: async (key: string, _minId: string, value: string) => { published.push({ key, value }); },
  getRedisStatus: () => ({ connected: true, lastError: null, lastPublishError: null }),
}));

import { saveAppConfig } from './appConfig';
import { publishRedeem } from './eventBus';

function lastEnvelope() { return JSON.parse(published[published.length - 1].value); }

describe('event bus', () => {
  beforeEach(() => { published.length = 0; saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' }); });
  afterEach(() => { saveAppConfig({ clearRedisUrl: true }); });

  test('no redisUrl -> publish is a no-op (nothing sent)', async () => {
    saveAppConfig({ clearRedisUrl: true });
    publishRedeem({ sourceId: 'm1', channel: { id: 'b1', login: 'streamer' }, rewardId: 'r1', rewardTitle: 'Hydrate', rewardSource: 'pztmi', rewardExternalRef: null, redemptionId: 'x1', userId: 'u1', userLogin: 'viewer', userInput: 'go' });
    await Promise.resolve();
    expect(published).toHaveLength(0);
  });

  test('builds a v1 envelope with a deterministic id and only allowlisted data keys', async () => {
    publishRedeem({ sourceId: 'm1', channel: { id: 'b1', login: 'streamer' }, rewardId: 'r1', rewardTitle: 'Hydrate', rewardSource: 'pztmi', rewardExternalRef: null, redemptionId: 'x1', userId: 'u1', userLogin: 'viewer', userInput: 'go' });
    await Promise.resolve();
    const env = lastEnvelope();
    expect(env.version).toBe(1);
    expect(env.type).toBe('redeem');
    expect(env.id).toBe('m1');                       // derived from source id
    expect(env.channel).toEqual({ id: 'b1', login: 'streamer' });
    expect(Object.keys(env.data).sort()).toEqual(
      ['redemptionId', 'rewardExternalRef', 'rewardId', 'rewardSource', 'rewardTitle', 'userId', 'userInput', 'userLogin'].sort(),
    );
    expect(env.data.rewardSource).toBe('pztmi');
  });

  test('a throwing redisPublish never escapes publishRedeem', async () => {
    mock.module('./redis', () => ({
      redisPublish: async () => { throw new Error('down'); },
      getRedisStatus: () => ({ connected: false, lastError: 'down', lastPublishError: 'down' }),
    }));
    const { publishRedeem: pr } = await import('./eventBus');
    expect(() => pr({ sourceId: 'm2', channel: { id: 'b1', login: 's' }, rewardId: 'r', rewardTitle: 't', rewardSource: null, rewardExternalRef: null, redemptionId: 'x', userId: 'u', userLogin: 'v', userInput: '' })).not.toThrow();
  });
});
