import { describe, expect, test } from 'bun:test';
import type { DashboardStatus } from '../shared/api';
import { chatConnectionWord, connectionWord, OBS_OFFLINE, obsConnectionLabel, serviceStateTitle } from './connectionWords';
import { connectionsLine, liveDataRows, UNKNOWN_VALUE } from './ui/statBarText';
import { serviceTransitionToasts, type ServiceSnapshot } from './ui/serviceTransitions';

/** The words this vocabulary exists to retire for "not connected". */
const RETIRED = /unavailable|disconnected|\bopen\b|\bclosed\b/i;

const status = (overrides: Partial<DashboardStatus>): DashboardStatus => ({
  obsConnected: true,
  eventSubConnected: true,
  eventSubError: null,
  redisConnected: true,
  lastPublishError: null,
  ...overrides,
} as DashboardStatus);

const up: ServiceSnapshot = { obs: true, eventSub: true, redis: true };
const down: ServiceSnapshot = { obs: false, eventSub: false, redis: false };

describe('connection vocabulary', () => {
  test('a service is connected or offline', () => {
    expect(connectionWord(true)).toBe('connected');
    expect(connectionWord(false)).toBe('offline');
    expect(serviceStateTitle('Redis', false)).toBe('Redis offline');
    expect(OBS_OFFLINE).toBe('OBS offline');
    expect(obsConnectionLabel(false)).toBe('Offline');
  });

  test("chat's socket states fold into the same words", () => {
    expect(chatConnectionWord('OPEN')).toBe('connected');
    expect(chatConnectionWord('CONNECTING')).toBe('connecting');
    expect(chatConnectionWord('CLOSING')).toBe('offline');
    expect(chatConnectionWord('CLOSED')).toBe('offline');
    expect(chatConnectionWord('UNKNOWN')).toBe('unknown');
  });

  test('the stat bar line says connected/offline, not open/closed', () => {
    expect(connectionsLine({ chatConnection: 'OPEN', eventSubConnected: true })).toBe('chat connected · events connected');
    const down = connectionsLine({ chatConnection: 'CLOSED', eventSubConnected: false });
    expect(down).toBe('chat offline · events offline');
    expect(down).not.toMatch(RETIRED);
  });
});

describe('service toasts', () => {
  test('the first heartbeat and a steady state say nothing', () => {
    expect(serviceTransitionToasts(null, status({ obsConnected: false }))).toEqual([]);
    expect(serviceTransitionToasts(up, status({}))).toEqual([]);
  });

  test('every service that drops is reported offline, never "disconnected"', () => {
    const toasts = serviceTransitionToasts(up, status({ obsConnected: false, eventSubConnected: false, redisConnected: false }));
    expect(toasts.map(toast => toast.title)).toEqual(['OBS offline', 'Twitch EventSub offline', 'Redis offline']);
    for (const toast of toasts) {
      expect(toast.kind).toBe('error');
      expect(toast.title).not.toMatch(RETIRED);
    }
  });

  test('every service that comes back is reported connected', () => {
    const toasts = serviceTransitionToasts(down, status({}));
    expect(toasts.map(toast => toast.title)).toEqual(['OBS connected', 'Twitch EventSub connected', 'Redis connected']);
  });

  test("a drop carries the server's reason when it gave one", () => {
    const [toast] = serviceTransitionToasts(up, status({ eventSubConnected: false, eventSubError: 'Token revoked' }));
    expect(toast?.message).toBe('Token revoked');
  });
});

describe('Display panel Live Data', () => {
  const live = { channel: 'codeacula', chatConnection: 'OPEN' as const, eventSubConnected: true, obsConnected: false };

  test('services use the shared words and an empty channel is not set', () => {
    expect(liveDataRows(live, true)).toEqual([
      { label: 'Channel', value: 'codeacula' },
      { label: 'Chat', value: 'connected' },
      { label: 'EventSub', value: 'connected' },
      { label: 'OBS', value: 'offline' },
    ]);
    const unset = liveDataRows({ ...live, channel: '', eventSubConnected: false }, true);
    expect(unset[0]?.value).toBe('not set');
    for (const row of unset) expect(row.value).not.toMatch(RETIRED);
  });

  test('before the first status every value is a dash, not a placeholder claim', () => {
    for (const row of liveDataRows({ ...live, channel: '' }, false)) expect(row.value).toBe(UNKNOWN_VALUE);
  });
});
