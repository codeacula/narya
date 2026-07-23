import { describe, expect, test } from 'bun:test';
import { RuntimeState } from '../runtime';
import { getDashboardStatusSnapshot } from './status';

describe('getDashboardStatusSnapshot', () => {
  test('reports redis health', async () => {
    const snap = await getDashboardStatusSnapshot(new RuntimeState());

    expect(snap).toHaveProperty('redisConnected');
    expect(typeof snap.redisConnected).toBe('boolean');
    expect(snap).toHaveProperty('lastPublishError');
    expect(snap.lastPublishError === null || typeof snap.lastPublishError === 'string').toBe(true);
  });
});
