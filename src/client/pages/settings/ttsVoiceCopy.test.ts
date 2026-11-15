import { describe, expect, test } from 'bun:test';
import { emptyVoicesCopy } from './ttsVoiceCopy';

describe('emptyVoicesCopy', () => {
  // The alert above the picker says "Tengwar offline"; the picker must use the same word.
  test('an unreachable Tengwar is "offline", never "unreachable"', () => {
    const copy = emptyVoicesCopy(false);
    expect(copy.option).toContain('Tengwar offline');
    expect(`${copy.option} ${copy.hint}`).not.toMatch(/unreachable|unavailable/i);
  });

  test('a probe still in flight does not claim Tengwar is offline', () => {
    expect(emptyVoicesCopy(null).option).not.toMatch(/offline/i);
  });

  test('a connected Tengwar with no voices does not say offline', () => {
    const copy = emptyVoicesCopy(true);
    expect(`${copy.option} ${copy.hint}`).not.toMatch(/offline/i);
    expect(copy.hint).toContain('Tengwar connected');
  });
});
