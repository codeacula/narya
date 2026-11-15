import { expect, test } from 'bun:test';
import { obsNotice } from './obsNotice';

const RAW = 'connect ECONNREFUSED 127.0.0.1:4455';
const offline = { connected: false, lastError: RAW };
const online = { connected: true, lastError: null };

test('an unreachable OBS is worded for the operator, with the raw error kept as detail', () => {
  const notice = obsNotice({ obsStatus: offline, loaded: true, statusError: null, commandError: null });
  expect(notice?.tone).toBe('offline');
  expect(notice?.message).toContain('OBS is offline');
  expect(notice?.message).not.toContain('ECONNREFUSED');
  expect(notice?.detail).toBe(RAW);
});

test('offline is still reported when the server gave no reason', () => {
  const notice = obsNotice({
    obsStatus: { connected: false, lastError: null },
    loaded: true,
    statusError: null,
    commandError: null,
  });
  expect(notice?.tone).toBe('offline');
  expect(notice?.detail).toBeNull();
});

test('nothing is said before the first status arrives, so the page does not flash offline', () => {
  expect(obsNotice({ obsStatus: { connected: false, lastError: null }, loaded: false, statusError: null, commandError: null }))
    .toBeNull();
});

test('a connected OBS with no error says nothing', () => {
  expect(obsNotice({ obsStatus: online, loaded: true, statusError: null, commandError: null })).toBeNull();
});

test('a failed request while connected is an error, not "offline"', () => {
  const notice = obsNotice({
    obsStatus: { connected: true, lastError: 'OBS request timed out' },
    loaded: true,
    statusError: null,
    commandError: null,
  });
  expect(notice?.tone).toBe('error');
  expect(notice?.message).not.toContain('offline');
  expect(notice?.detail).toBe('OBS request timed out');
});

test("the operator's failed command outranks the standing offline state", () => {
  const notice = obsNotice({ obsStatus: offline, loaded: true, statusError: null, commandError: 'Failed to play sound quack' });
  expect(notice).toEqual({ message: 'Failed to play sound quack', detail: null, tone: 'error' });
});

test('Narya not answering is not mistaken for OBS being down', () => {
  const notice = obsNotice({ obsStatus: offline, loaded: false, statusError: 'Failed to fetch', commandError: null });
  expect(notice?.tone).toBe('error');
  expect(notice?.message).not.toContain('OBS is offline');
  expect(notice?.detail).toBe('Failed to fetch');
});
