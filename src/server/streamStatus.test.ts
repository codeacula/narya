import { beforeEach, describe, expect, test } from 'bun:test';
import { adjustCounterByKey, createCounter } from './counters';
import { db } from './db';
import { getStreamStatus, getStreamStatusRaw, saveStreamStatus } from './streamStatus';

describe('stream status', () => {
  beforeEach(() => {
    db.exec('delete from stream_status');
  });

  test('defaults to empty text when unset', () => {
    expect(getStreamStatus()).toEqual({ text: '', updatedAt: '' });
  });

  test('saving stores and returns the text with a timestamp', () => {
    const saved = saveStreamStatus({ text: 'brb in 5' });
    expect(saved.text).toBe('brb in 5');
    expect(saved.updatedAt).not.toBe('');
    expect(getStreamStatus().text).toBe('brb in 5');
  });

  test('saving again replaces the prior value', () => {
    saveStreamStatus({ text: 'first' });
    saveStreamStatus({ text: 'second' });
    expect(getStreamStatus().text).toBe('second');
  });

  test('text is trimmed', () => {
    expect(saveStreamStatus({ text: '   spaced   ' }).text).toBe('spaced');
  });

  test('non-string or missing text becomes empty', () => {
    expect(saveStreamStatus({ text: 42 }).text).toBe('');
    expect(saveStreamStatus({}).text).toBe('');
    expect(saveStreamStatus(null).text).toBe('');
  });

  test('text is capped at 280 characters', () => {
    const saved = saveStreamStatus({ text: 'a'.repeat(400) });
    expect(saved.text.length).toBe(280);
  });
});

describe('stream status and counters', () => {
  beforeEach(() => {
    db.exec('delete from stream_status');
    db.exec('delete from counters');
  });

  const counter = (key: string, value: number) =>
    createCounter({ key, label: key, value });

  test('renders a counter token into the public text', () => {
    counter('deaths', 42);
    saveStreamStatus({ text: 'Total Deaths: {counter:deaths}' });
    expect(getStreamStatus().text).toBe('Total Deaths: 42');
  });

  test('stores the raw text so the token survives a save', () => {
    counter('deaths', 42);
    saveStreamStatus({ text: 'Total Deaths: {counter:deaths}' });
    expect(getStreamStatusRaw().rawText).toBe('Total Deaths: {counter:deaths}');
  });

  test('re-renders when the counter moves, without another save', () => {
    counter('deaths', 1);
    saveStreamStatus({ text: 'Deaths: {counter:deaths}' });
    adjustCounterByKey('deaths', 'add', 1);
    expect(getStreamStatus().text).toBe('Deaths: 2');
  });

  /**
   * The round-trip that would otherwise destroy the operator's tokens: the Stream
   * Info modal loads the status, then PUTs it back on save even when it was never
   * edited. Loading the RENDERED text would store "Deaths: 42" as the new raw text.
   */
  test('load-then-save-unchanged preserves the token rather than freezing its value', () => {
    counter('deaths', 42);
    saveStreamStatus({ text: 'Deaths: {counter:deaths}' });

    const loadedByTheEditor = getStreamStatusRaw().rawText;
    saveStreamStatus({ text: loadedByTheEditor });

    expect(getStreamStatusRaw().rawText).toBe('Deaths: {counter:deaths}');
    adjustCounterByKey('deaths', 'add', 1);
    expect(getStreamStatus().text).toBe('Deaths: 43');
  });

  /**
   * GET /api/stream-status is on OVERLAY_PATHS and status:updated is on
   * OVERLAY_EVENTS, and broadcasts are filtered by event name only — there is no
   * per-field redaction downstream. So the public shape must carry no raw text.
   */
  test('the public status carries no rawText field at all', () => {
    counter('deaths', 42);
    saveStreamStatus({ text: 'Deaths: {counter:deaths}' });

    const status = getStreamStatus();
    expect(Object.keys(status).sort()).toEqual(['text', 'updatedAt']);
    expect('rawText' in status).toBe(false);
    expect(JSON.stringify(status)).not.toContain('{counter:');
  });

  test('the value returned from a save is the public shape too', () => {
    counter('deaths', 7);
    const saved = saveStreamStatus({ text: 'Deaths: {counter:deaths}' });
    expect(Object.keys(saved).sort()).toEqual(['text', 'updatedAt']);
    expect(saved.text).toBe('Deaths: 7');
  });

  test('an unknown counter key stays literal instead of rendering empty', () => {
    saveStreamStatus({ text: 'Deaths: {counter:missing}' });
    expect(getStreamStatus().text).toBe('Deaths: {counter:missing}');
  });

  test('the length cap applies to the raw text, so a token is never cut in half', () => {
    counter('deaths', 42);
    const padding = 'x'.repeat(270);
    saveStreamStatus({ text: `${padding}{counter:deaths}` });
    // 270 + 18 exceeds 280, so the raw text is truncated — but at the stored text's
    // own boundary, not partway through rendering.
    expect(getStreamStatusRaw().rawText.length).toBe(280);
  });
});
