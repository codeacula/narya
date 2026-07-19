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
import {
  applyWindDownTitle,
  reconcileWindDownOnBoot,
  resetWindDownRetryBackoffForTests,
  startWindDownLoop,
  tick,
  type WindDownTitlePort,
} from './windDownLoop';

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
  // The retry backoff counters are module state (Finding 4) — reset them so a test
  // that deliberately runs a streak of failures can't leak it into the next test.
  resetWindDownRetryBackoffForTests();
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

  // Finding 1: titleEnabled must gate putting a NEW suffix up, not taking an
  // already-applied one back down. Before the fix, this early-returned exactly like
  // the activation case above, leaving the suffix live on the title forever with
  // nothing left recording what to restore it to — observed here as fake.title
  // staying 'Modding Skyrim | Ending soon' instead of being restored.
  test('restoring a live suffix happens even while the title effect is disabled', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true); // suffix goes up while enabled
    expect(fake.title).toBe('Modding Skyrim | Ending soon');

    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Ending soon', titleEnabled: false, overlayEnabled: true });

    await applyWindDownTitle(fake.port, false);
    expect(fake.title).toBe('Modding Skyrim');
    expect(getWindDownState().baseTitle).toBeNull();
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

  // Finding 1: the old reconcile trusted the stale stored base whenever the live
  // title merely ENDED with the configured suffix. An operator editing the suffixed
  // title they can see has no way to know the trailing text is app-managed, and can
  // plausibly retype only the base while leaving a suffix that happens to still
  // match — the old heuristic read that as "unchanged" and silently overwrote the
  // edit with the stale stored base ('Modding Skyrim' instead of 'Modding Fallout').
  test('an operator edit that happens to keep the suffix is not clobbered by the stale stored base', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true); // baseTitle 'Modding Skyrim', appliedSuffix '| Ending soon'
    setWindDownActive({ active: true, source: 'scheduled' });

    // Operator retitles on Twitch directly while we're down, changing only the base
    // and — plausibly, since they can't tell the tail is app-managed — leaving the
    // suffix in place.
    const afterRestart = fakePort('Modding Fallout | Ending soon');
    await reconcileWindDownOnBoot(afterRestart.port);

    expect(getWindDownState().baseTitle).toBe('Modding Fallout');
    expect(afterRestart.title).toBe('Modding Fallout | Ending soon');
  });

  // Finding 2: nothing reapplies the live title when the suffix setting changes
  // while active, so the live title still carries the OLD suffix. The old reconcile
  // checked the live title against the NEW configured suffix, saw no match, and
  // adopted the WHOLE live title — old suffix included — as the base, so composing
  // with the new suffix double-stacked it. Recording the suffix that was actually
  // applied fixes this: reconcile strips exactly that, regardless of what the
  // setting has since changed to.
  test('a changed suffix setting does not double-stack on restart', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true); // applies '| Ending soon'
    setWindDownActive({ active: true, source: 'scheduled' });

    // The operator changes the suffix setting while wind-down is active. Nothing
    // reapplies the live title for that (a separate, accepted gap), so the channel
    // title still carries the OLD suffix going into the restart.
    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Wrapping up', titleEnabled: true, overlayEnabled: true });

    // Simulate a restart with the live title unchanged.
    const afterRestart = fakePort(fake.title);
    await reconcileWindDownOnBoot(afterRestart.port);

    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
    expect(afterRestart.title).toBe('Modding Skyrim | Wrapping up');
  });

  // Finding 1 (CRITICAL): reconcile used to persist the NEW appliedSuffix (via
  // setWindDownTitleState) before applyWindDownTitle's own Twitch write had actually
  // landed. If that write then failed — an ordinary transient boot failure, token
  // refresh, a Twitch 5xx — the DB recorded a suffix that was never applied. A later
  // reconcile would then strip a suffix the live title doesn't carry and double-stack
  // it (exactly the "Modding Skyrim | Ending soon | Wrapping up" scenario).
  test('a failed reconcile write leaves the persisted state describing what is actually still live', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true); // live: 'Modding Skyrim | Ending soon'
    setWindDownActive({ active: true, source: 'scheduled' });

    // The operator changes the suffix setting while wind-down is active. Nothing
    // reapplies the live title for that, so the channel still carries the OLD suffix
    // going into the restart.
    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Wrapping up', titleEnabled: true, overlayEnabled: true });

    // Simulate a restart whose Twitch write fails (transient boot failure).
    const afterRestart = fakePort(fake.title); // still 'Modding Skyrim | Ending soon'
    afterRestart.failNextWrite = true;

    await expect(reconcileWindDownOnBoot(afterRestart.port)).rejects.toThrow('Twitch is down');

    // The write never landed — the live title is unchanged. Persisted state must
    // still describe exactly that: appliedSuffix must NOT claim '| Wrapping up' went
    // out, since it never did. Before the fix this observed appliedSuffix ===
    // '| Wrapping up' here, corrupting the pair the next reconcile relies on.
    expect(afterRestart.title).toBe('Modding Skyrim | Ending soon');
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
    expect(getWindDownState().appliedSuffix).toBe('| Ending soon');
  });

  // This review's Finding 2: a base long enough that base + suffix must be
  // truncated to fit Twitch's 140-character limit. applyWindDownTitle stores the
  // FULL base (by design — see windDownTitle.ts), but the LIVE title only ever
  // carries the truncated one. Before the fix, reconcile derived straight from the
  // live (truncated) title and overwrote the stored full base with it — observed
  // here as getWindDownState().baseTitle shrinking from the 160+ character
  // original down to whatever fit before the "…", permanently discarding the rest.
  test('a restart does not permanently shorten a base that had to be truncated to fit', async () => {
    const fullBase = `${'word '.repeat(30)}really truly`;
    const fake = fakePort(fullBase);
    await applyWindDownTitle(fake.port, true);
    setWindDownActive({ active: true, source: 'scheduled' });

    // Confirm the premise: activation actually needed to truncate for this test to
    // mean anything.
    expect(fake.title.length).toBeLessThanOrEqual(140);
    expect(fake.title).toContain('…');
    expect(getWindDownState().baseTitle).toBe(fullBase);

    // Simulate a restart: the live title is whatever got truncated onto Twitch.
    const afterRestart = fakePort(fake.title);
    await reconcileWindDownOnBoot(afterRestart.port);

    expect(getWindDownState().baseTitle).toBe(fullBase);
    // Nothing changed out-of-band, so the live title must come out identical too —
    // not re-truncated a second time from a shorter starting point.
    expect(afterRestart.title).toBe(fake.title);
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

  // Finding 3: the mirror image of the activation retry above. Before this fix,
  // tick() had no code path at all for "inactive with a base title still on file" —
  // a failed restore (e.g. from resetWindDownForStreamEnd at stream end) would sit
  // there forever unless a redelivered stream.offline happened to come along.
  test('retries a failed restore write on the next tick, and stops once it lands', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true); // baseTitle captured, suffix applied
    setWindDownActive({ active: true, source: 'scheduled' });
    // Deactivate WITHOUT going through a successful restore, as a failed
    // resetWindDownForStreamEnd would leave things: inactive, baseTitle still set.
    setWindDownActive({ active: false, source: 'action' });
    fake.failNextWrite = true;

    await tick(fake.port); // tick attempts the restore; the Twitch write fails
    expect(getWindDownState().active).toBe(false);
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
    expect(fake.title).toBe('Modding Skyrim | Ending soon'); // still un-restored

    await tick(fake.port); // retry — this time it succeeds
    expect(getWindDownState().baseTitle).toBeNull();
    expect(fake.title).toBe('Modding Skyrim');

    fake.writes.length = 0;
    await tick(fake.port); // nothing left to retry
    expect(fake.writes).toHaveLength(0);
  });

  // This review's Finding 1: the restore retry used to also require
  // settings.titleEnabled, so an operator who disabled "Update the Twitch title"
  // exactly while a restore attempt was failing would strand the suffix on the
  // title with no further retries — the tick loop would just silently stop trying.
  test('retries a failed restore even while the title effect is disabled', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'action' });
    fake.failNextWrite = true;

    await tick(fake.port); // restore attempt fails
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');

    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Ending soon', titleEnabled: false, overlayEnabled: true });

    await tick(fake.port); // retry must still fire despite titleEnabled being false
    expect(getWindDownState().baseTitle).toBeNull();
    expect(fake.title).toBe('Modding Skyrim');
  });

  // Finding 4: against a permanent failure (revoked OAuth, say) the retry above
  // would otherwise attempt — and log — every single tick for the rest of the
  // stream. Assert the backoff actually reduces attempts rather than firing on
  // every one of many consecutive ticks.
  test('backs off retrying a permanently failing restore instead of hammering every tick', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'action' }); // inactive, baseTitle still set

    let attempts = 0;
    const alwaysFailingPort: WindDownTitlePort = {
      getTitle: fake.port.getTitle,
      setTitle: async () => { attempts += 1; throw new Error('Twitch is down'); },
    };

    for (let i = 0; i < 20; i++) {
      await tick(alwaysFailingPort);
    }

    // Full-speed for the first burst of failures, then backed off — 20 consecutive
    // ticks must not mean 20 attempts (and 20 log lines).
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(20);
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

// This review's Finding 1, end to end, wired through the real applier exactly as
// index.ts registers it: wind-down active and suffixing the title -> operator
// unchecks "Update the Twitch title" in Settings -> stream ends. Before the fix,
// this observed the live title stuck at "Modding Skyrim | Ending soon" forever while
// the DB's baseTitle/appliedSuffix were wiped to null — the exact corruption the
// load-bearing invariant forbids (stored state no longer describes the live title,
// and the one record of what to restore is gone).
describe('resetWindDownForStreamEnd when the title effect gets disabled mid-wind-down (Finding 1)', () => {
  test('the live title is actually restored, not just marked as restored', async () => {
    const fake = fakePort('Modding Skyrim');
    setWindDownTitleApplier(active => applyWindDownTitle(fake.port, active));
    try {
      getOrStartStreamSession('test-finding-1-e2e', '2026-07-19T18:00:00.000Z');
      setWindDownActive({ active: true, source: 'scheduled' });
      await applyWindDownTitle(fake.port, true);
      expect(fake.title).toBe('Modding Skyrim | Ending soon');

      // The operator turns off title updates while wind-down is still active.
      saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Ending soon', titleEnabled: false, overlayEnabled: true });

      await resetWindDownForStreamEnd();

      expect(fake.title).toBe('Modding Skyrim');
      expect(getWindDownState().baseTitle).toBeNull();
      expect(getWindDownState().appliedSuffix).toBeNull();
    } finally {
      setWindDownTitleApplier(null);
    }
  });
});
