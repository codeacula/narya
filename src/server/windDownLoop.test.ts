import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getOrStartStreamSession } from './streamSession';
import { getWindDownState, saveWindDownSettings, setWindDownActive } from './windDown';
import { applyWindDownTitle, reconcileWindDownOnBoot, type WindDownTitlePort } from './windDownLoop';

/** A fake Twitch channel whose title we can read back. */
function fakePort(initialTitle: string) {
  const port = {
    title: initialTitle,
    reads: 0,
    writes: [] as string[],
    failNextWrite: false,
    port: null as unknown as WindDownTitlePort,
  };
  port.port = {
    getTitle: async () => { port.reads += 1; return port.title; },
    setTitle: async (next: string) => {
      if (port.failNextWrite) { port.failNextWrite = false; throw new Error('Twitch is down'); }
      port.title = next;
      port.writes.push(next);
    },
  };
  return port;
}

beforeEach(() => {
  db.exec('delete from wind_down_state');
  db.exec('delete from wind_down_settings');
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
  getOrStartStreamSession('test', '2026-07-19T18:00:00.000Z');
});

describe('applyWindDownTitle', () => {
  test('captures the base title and appends the suffix', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    expect(fake.title).toBe('Modding Skyrim | Ending soon');
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
  });

  test('restores the base title and forgets it', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    await applyWindDownTitle(fake.port, false);
    expect(fake.title).toBe('Modding Skyrim');
    expect(getWindDownState().baseTitle).toBeNull();
  });

  // The bug this guards: appending to the LIVE title rather than recomputing from
  // the stored base, so a second activation stacks a second suffix.
  test('activating twice never stacks the suffix', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    await applyWindDownTitle(fake.port, true);
    expect(fake.title).toBe('Modding Skyrim | Ending soon');
  });

  test('does nothing when the title effect is disabled', async () => {
    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Ending soon', titleEnabled: false, overlayEnabled: true });
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    expect(fake.writes).toHaveLength(0);
    expect(fake.title).toBe('Modding Skyrim');
  });

  test('deactivating with no stored base title writes nothing', async () => {
    const fake = fakePort('Something Else');
    await applyWindDownTitle(fake.port, false);
    expect(fake.writes).toHaveLength(0);
  });

  // A failed title update must not lose the base title, or the restore path has
  // nothing to restore to.
  test('a Twitch failure propagates without stranding the base title', async () => {
    const fake = fakePort('Modding Skyrim');
    fake.failNextWrite = true;
    await expect(applyWindDownTitle(fake.port, true)).rejects.toThrow('Twitch is down');
    expect(fake.title).toBe('Modding Skyrim');
  });
});

describe('reconcileWindDownOnBoot', () => {
  // The failure this exists for: a restart mid-wind-down leaving "| Ending soon"
  // welded to the title into the next stream.
  test('re-applies the suffix when the stored state says active', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    setWindDownActive({ active: true, source: 'scheduled' });

    // Simulate a restart: the channel title is whatever we left it as.
    const afterRestart = fakePort(fake.title);
    await reconcileWindDownOnBoot(afterRestart.port);
    expect(afterRestart.title).toBe('Modding Skyrim | Ending soon');
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
  });

  test('does nothing when wind-down is not active', async () => {
    const fake = fakePort('Modding Skyrim');
    await reconcileWindDownOnBoot(fake.port);
    expect(fake.writes).toHaveLength(0);
  });
});
