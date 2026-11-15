import { describe, expect, test } from 'bun:test';
import { chatEmpty, eventFeedEmpty } from './feedEmpty';

describe('chatEmpty', () => {
  const base = { total: 0, visible: 0, query: '' };

  test('a chat with messages on screen says nothing', () => {
    expect(chatEmpty({ ...base, phase: 'fresh', total: 3, visible: 3 })).toBeNull();
    expect(chatEmpty({ ...base, phase: 'stale', total: 3, visible: 1, query: 'hi' })).toBeNull();
  });

  test('a failed first load is unavailable with a retry, not an empty chat', () => {
    const empty = chatEmpty({ ...base, phase: 'failed' });
    expect(empty?.title).toBe('Chat unavailable');
    expect(empty?.actions).toEqual(['retry']);
  });

  test('before the first load lands it is loading, not empty', () => {
    expect(chatEmpty({ ...base, phase: 'loading' })?.title).toBe('Loading chat…');
  });

  test('a loaded, empty chat is a quiet chat', () => {
    expect(chatEmpty({ ...base, phase: 'fresh' })?.title).toBe('No chat yet');
    // A surface that does not track loading always has its data.
    expect(chatEmpty(base)?.title).toBe('No chat yet');
  });

  test('a search that hides everything says so and offers to clear itself', () => {
    const empty = chatEmpty({ phase: 'fresh', total: 4, visible: 0, query: ' raid ' });
    expect(empty?.title).toBe('No matching messages');
    expect(empty?.sub).toContain('“raid”');
    expect(empty?.actions).toEqual(['clear-search']);
  });
});

describe('eventFeedEmpty', () => {
  const base = { total: 0, visible: 0, query: '', hiddenLabels: [] as string[], allHidden: false };

  test('a feed with visible events says nothing', () => {
    expect(eventFeedEmpty({ ...base, phase: 'fresh', total: 2, visible: 1 })).toBeNull();
  });

  test('no events, loading and failed are three different sentences', () => {
    expect(eventFeedEmpty({ ...base, phase: 'fresh' })?.title).toBe('No activity yet');
    expect(eventFeedEmpty({ ...base, phase: 'loading' })?.title).toBe('Loading activity…');
    const failed = eventFeedEmpty({ ...base, phase: 'failed' });
    expect(failed?.title).toBe('Activity unavailable');
    expect(failed?.actions).toEqual(['retry']);
  });

  test('every kind filtered off names the filters and offers to clear them', () => {
    const empty = eventFeedEmpty({ ...base, phase: 'fresh', total: 3, hiddenLabels: ['Follows', 'Ad Breaks'], allHidden: true });
    expect(empty?.title).toBe('Everything is filtered out');
    expect(empty?.sub).toBe('3 events hidden by the kind filters (Follows, Ad Breaks).');
    expect(empty?.actions).toEqual(['clear-filters']);
  });

  test('a search with no match is not mistaken for the filters', () => {
    const empty = eventFeedEmpty({ ...base, phase: 'fresh', total: 3, query: 'zed' });
    expect(empty?.title).toBe('No matching activity');
    expect(empty?.actions).toEqual(['clear-search']);
    const withHidden = eventFeedEmpty({ ...base, phase: 'fresh', total: 3, query: 'zed', hiddenLabels: ['Ad Breaks'] });
    expect(withHidden?.sub).toContain('Hidden: Ad Breaks');
    expect(withHidden?.actions).toEqual(['clear-search', 'clear-filters']);
  });
});
