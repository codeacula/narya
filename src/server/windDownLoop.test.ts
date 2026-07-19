import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { getOrStartStreamSession, setPlannedStreamEnd } from './streamSession';
import { db } from './db';
import { RuntimeState } from './runtime';
import {
  getWindDownState,
  resetWindDownForStreamEnd,
  saveWindDownSettings,
  setWindDownActive,
  setWindDownTitleApplier,
} from './windDown';
import { applyWindDownTitle, reconcileWindDownOnBoot, startWindDownLoop, tick, type WindDownTitlePort } from './windDownLoop';

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

let sessionId: string;

beforeEach(() => {
  db.exec('delete from wind_down_state');
  db.exec('delete from wind_down_settings');
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
  sessionId = getOrStartStreamSession('test', '2026-07-19T18:00:00.000Z').id;
  setWindDownTitleApplier(null);
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

  // Finding 4: activate -> process dies -> the operator edits the title directly on
  // Twitch -> restart. The stale stored baseTitle must not clobber that edit.
  test('adopts a live title the operator changed directly on Twitch while the process was down', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    setWindDownActive({ active: true, source: 'scheduled' });

    // The operator retitles on Twitch directly while we're down — no suffix on it.
    const afterRestart = fakePort('Modding Fallout');
    await reconcileWindDownOnBoot(afterRestart.port);

    expect(getWindDownState().baseTitle).toBe('Modding Fallout');
    expect(afterRestart.title).toBe('Modding Fallout | Ending soon');
  });
});

describe('tick', () => {
  test('activates and suffixes the title inside the lead window', async () => {
    setPlannedStreamEnd(sessionId, new Date(Date.now() + 5 * 60_000).toISOString());
    const fake = fakePort('Modding Skyrim');

    await tick(fake.port);

    expect(getWindDownState().active).toBe(true);
    expect(getWindDownState().source).toBe('scheduled');
    expect(fake.title).toBe('Modding Skyrim | Ending soon');
  });

  test('does nothing before the lead window opens', async () => {
    setPlannedStreamEnd(sessionId, new Date(Date.now() + 60 * 60_000).toISOString());
    const fake = fakePort('Modding Skyrim');

    await tick(fake.port);

    expect(getWindDownState().active).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  test('does nothing after a manual dismissal for the current session', async () => {
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'manual' }); // latches dismissedSessionId
    setPlannedStreamEnd(sessionId, new Date(Date.now() + 5 * 60_000).toISOString());
    const fake = fakePort('Modding Skyrim');

    await tick(fake.port);

    expect(getWindDownState().active).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  test('does nothing while off-stream', async () => {
    db.exec('delete from stream_sessions');
    const fake = fakePort('Modding Skyrim');

    await tick(fake.port);

    expect(getWindDownState().active).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  // Finding 3: tick() used to return early on anything but 'activate', so a Twitch
  // outage exactly at activation time left the title unsuffixed for the rest of the
  // stream while the dashboard still showed "active". baseTitle stays null until a
  // write actually lands — that's the signal this retries on, and stops on.
  test('retries a failed activation write on the next tick, and stops once it lands', async () => {
    setPlannedStreamEnd(sessionId, new Date(Date.now() + 5 * 60_000).toISOString());
    const fake = fakePort('Modding Skyrim');
    fake.failNextWrite = true;

    await tick(fake.port); // activation attempt; the Twitch write fails
    expect(getWindDownState().active).toBe(true);
    expect(getWindDownState().baseTitle).toBeNull();
    expect(fake.writes).toHaveLength(0);
    expect(fake.title).toBe('Modding Skyrim');

    await tick(fake.port); // retry — this time it succeeds
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
    expect(fake.writes).toHaveLength(1);
    expect(fake.title).toBe('Modding Skyrim | Ending soon');

    await tick(fake.port); // nothing left to retry
    expect(fake.writes).toHaveLength(1);
  });
});

describe('startWindDownLoop', () => {
  // Finding 5: startWindDownLoop already clears its previous interval before
  // creating a new one; this had no test proving a second call doesn't leak one.
  test('called twice does not leak an interval', () => {
    const setIntervalSpy = spyOn(global, 'setInterval');
    const clearIntervalSpy = spyOn(global, 'clearInterval');
    try {
      const state = new RuntimeState();
      startWindDownLoop(state);
      startWindDownLoop(state);
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      // Every interval this test created must die with it, or it keeps firing
      // real tick()s (and keeping the process alive) long after the test ends.
      for (const result of setIntervalSpy.mock.results) {
        if (result.type === 'return') clearInterval(result.value as ReturnType<typeof setInterval>);
      }
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});

// Finding 2 (CRITICAL), end to end: without resetWindDownForStreamEnd, wind-down
// state left active from a prior stream makes evaluateWindDown return
// 'already_active' forever, so the very next stream's tick() could never activate
// wind-down again, and the previous stream's suffix would never come off.
describe('resetWindDownForStreamEnd → next stream (Finding 2)', () => {
  test('a stream-end reset lets the very next stream activate again', async () => {
    const fake = fakePort('Stream A title');
    setWindDownTitleApplier(active => applyWindDownTitle(fake.port, active));
    try {
      setWindDownActive({ active: true, source: 'scheduled' });
      await applyWindDownTitle(fake.port, true);
      expect(fake.title).toBe('Stream A title | Ending soon');

      // Simulate the stream.offline handler.
      await resetWindDownForStreamEnd();
      expect(fake.title).toBe('Stream A title');
      expect(getWindDownState().active).toBe(false);

      // A brand-new stream starts.
      const sessionB = getOrStartStreamSession('test-next-stream', '2026-07-19T20:00:00.000Z');
      setPlannedStreamEnd(sessionB.id, new Date(Date.now() + 5 * 60_000).toISOString());

      await tick(fake.port);

      expect(getWindDownState().active).toBe(true);
      expect(getWindDownState().sessionId).toBe(sessionB.id);
      expect(fake.title).toBe('Stream A title | Ending soon');
    } finally {
      setWindDownTitleApplier(null);
    }
  });
});
