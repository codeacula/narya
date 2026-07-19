import type express from 'express';
import type { PlannedStreamEnd, WindDownPublicState, WindDownSettings, WindDownSource } from '../shared/api';
import { NO_ACTIVE_SESSION_FOR_PLANNED_END } from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import { clampFinite } from './numeric';
import { broadcast } from './realtime';
import { getCurrentStreamSessionId, getPlannedStreamEnd, setPlannedStreamEnd } from './streamSession';
import { composeWindDownTitle, MAX_TWITCH_TITLE_LENGTH, stripWindDownSuffix } from './windDownTitle';

/**
 * Wind-down: the switch that says "this stream is wrapping up". Twitch exposes no
 * way to block an incoming raid, so this signals a prospective raider through the
 * channel title and an overlay countdown rather than preventing anything.
 *
 * Settings and state are separate rows for separate reasons: settings are operator
 * configuration edited in Settings, state is runtime and must survive a restart.
 */

const SETTINGS_ID = 'default';

/** Twelve hours. Beyond this a "lead time" is not a lead time. */
const MAX_LEAD_MINUTES = 720;
const MAX_SUFFIX_LENGTH = 60;

const DEFAULT_SETTINGS = {
  leadMinutes: 15,
  titleSuffix: '| Ending soon',
  titleEnabled: true,
  overlayEnabled: true,
} as const;

/** The stored row, including the fields that must never reach a browser source. */
export type WindDownStoredState = {
  active: boolean;
  activatedAt: string | null;
  source: WindDownSource | null;
  sessionId: string | null;
  baseTitle: string | null;
  // The suffix that was actually applied alongside baseTitle. Recorded so
  // reconcile-on-boot can strip exactly what was written to the live title instead
  // of guessing from whatever the suffix setting currently says — a setting change
  // while active must not be confused with the suffix that is actually out there.
  appliedSuffix: string | null;
  dismissedSessionId: string | null;
};

type SettingsRow = {
  leadMinutes: number;
  titleSuffix: string;
  titleEnabled: number;
  overlayEnabled: number;
  updatedAt: string;
};

type StateRow = {
  active: number;
  activatedAt: string | null;
  source: string | null;
  sessionId: string | null;
  baseTitle: string | null;
  appliedSuffix: string | null;
  dismissedSessionId: string | null;
};

const selectSettings = db.prepare(`
  select
    lead_minutes as leadMinutes,
    title_suffix as titleSuffix,
    title_enabled as titleEnabled,
    overlay_enabled as overlayEnabled,
    updated_at as updatedAt
  from wind_down_settings
  where id = ?
`);

const seedSettings = db.prepare(`
  insert or ignore into wind_down_settings
    (id, lead_minutes, title_suffix, title_enabled, overlay_enabled, updated_at)
  values (?, ?, ?, ?, ?, ?)
`);

const updateSettings = db.prepare(`
  update wind_down_settings set
    lead_minutes = ?,
    title_suffix = ?,
    title_enabled = ?,
    overlay_enabled = ?,
    updated_at = ?
  where id = ?
`);

const selectState = db.prepare(`
  select
    active,
    activated_at as activatedAt,
    source,
    session_id as sessionId,
    base_title as baseTitle,
    applied_suffix as appliedSuffix,
    dismissed_session_id as dismissedSessionId
  from wind_down_state
  where id = 1
`);

const upsertState = db.prepare(`
  insert into wind_down_state
    (id, active, activated_at, source, session_id, base_title, applied_suffix, dismissed_session_id)
  values (1, ?, ?, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    active = excluded.active,
    activated_at = excluded.activated_at,
    source = excluded.source,
    session_id = excluded.session_id,
    base_title = excluded.base_title,
    applied_suffix = excluded.applied_suffix,
    dismissed_session_id = excluded.dismissed_session_id
`);

function nowIso(): string {
  return new Date().toISOString();
}

function seedSettingsIfMissing() {
  seedSettings.run(
    SETTINGS_ID,
    DEFAULT_SETTINGS.leadMinutes,
    DEFAULT_SETTINGS.titleSuffix,
    DEFAULT_SETTINGS.titleEnabled ? 1 : 0,
    DEFAULT_SETTINGS.overlayEnabled ? 1 : 0,
    nowIso(),
  );
}

export function getWindDownSettings(): WindDownSettings {
  // Finding 6: this used to run `insert or ignore` on every call — including the
  // overlay's GET /api/wind-down and every winddown:updated broadcast — turning a
  // read path into a write on every single invocation. Read first, and only pay
  // for the seed on the rare path where the row is genuinely missing (first boot,
  // or a test that reset the table), rather than on every read.
  const row = selectSettings.get(SETTINGS_ID) as SettingsRow | undefined;
  if (!row) {
    seedSettingsIfMissing();
    return getWindDownSettings();
  }
  return {
    leadMinutes: row.leadMinutes,
    titleSuffix: row.titleSuffix,
    titleEnabled: row.titleEnabled === 1,
    overlayEnabled: row.overlayEnabled === 1,
    updatedAt: row.updatedAt || null,
  };
}

export function saveWindDownSettings(body: unknown): WindDownSettings {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const prev = getWindDownSettings();

  const leadMinutes = value.leadMinutes !== undefined
    ? Math.round(clampFinite(Number(value.leadMinutes), 0, MAX_LEAD_MINUTES, DEFAULT_SETTINGS.leadMinutes))
    : prev.leadMinutes;

  const rawSuffix = value.titleSuffix !== undefined ? String(value.titleSuffix).trim() : prev.titleSuffix;

  // A suffix with no room left for a title would make every wind-down title update
  // fail with a 400 the operator would never see. Refuse it here instead — checked
  // against the raw submission, before the slice below would silently mask how long
  // it actually was.
  if (rawSuffix.length >= MAX_TWITCH_TITLE_LENGTH) {
    throw new HttpRouteError(400, `The title suffix must be shorter than ${MAX_TWITCH_TITLE_LENGTH} characters.`);
  }

  const titleSuffix = rawSuffix.slice(0, MAX_SUFFIX_LENGTH);

  const titleEnabled = value.titleEnabled !== undefined ? value.titleEnabled === true : prev.titleEnabled;
  const overlayEnabled = value.overlayEnabled !== undefined ? value.overlayEnabled === true : prev.overlayEnabled;

  updateSettings.run(
    leadMinutes,
    titleSuffix,
    titleEnabled ? 1 : 0,
    overlayEnabled ? 1 : 0,
    nowIso(),
    SETTINGS_ID,
  );
  return getWindDownSettings();
}

export function getWindDownState(): WindDownStoredState {
  const row = selectState.get() as StateRow | null;
  if (!row) {
    return {
      active: false,
      activatedAt: null,
      source: null,
      sessionId: null,
      baseTitle: null,
      appliedSuffix: null,
      dismissedSessionId: null,
    };
  }
  return {
    active: row.active === 1,
    activatedAt: row.activatedAt,
    source: (row.source as WindDownSource | null) ?? null,
    sessionId: row.sessionId,
    baseTitle: row.baseTitle,
    appliedSuffix: row.appliedSuffix,
    dismissedSessionId: row.dismissedSessionId,
  };
}

function writeState(state: WindDownStoredState) {
  upsertState.run(
    state.active ? 1 : 0,
    state.activatedAt,
    state.source,
    state.sessionId,
    state.baseTitle,
    state.appliedSuffix,
    state.dismissedSessionId,
  );
}

/**
 * What goes on the wire. `baseTitle`, `sessionId`, and `dismissedSessionId` are
 * deliberately absent: `winddown:updated` is on the overlay allowlist, and a browser
 * source has no business seeing the operator's stored title.
 */
export function getWindDownPublicState(): WindDownPublicState {
  const settings = getWindDownSettings();
  // Finding 4: only ever hold a Pick of the safe fields in this scope — never the
  // full WindDownStoredState. TypeScript does not excess-property-check a spread,
  // so if a `state` variable of the full stored type were sitting right here, a
  // future `return { ...state, plannedEndAt, overlayEnabled }` would compile clean
  // and put baseTitle/sessionId/dismissedSessionId onto winddown:updated, which
  // unauthenticated overlay sources receive. Destructuring through an explicit
  // Pick at the one call to getWindDownState() means widening it would be a
  // compile error right here, not a silent leak discovered later.
  const { active, source, activatedAt }: Pick<WindDownStoredState, 'active' | 'source' | 'activatedAt'> =
    getWindDownState();
  return {
    active,
    source,
    activatedAt,
    plannedEndAt: getPlannedStreamEnd(),
    overlayEnabled: settings.overlayEnabled,
  };
}

export function broadcastWindDown() {
  broadcast('winddown:updated', getWindDownPublicState());
}

/**
 * The Twitch title write for wind-down lives in windDownLoop.ts, which imports
 * twitch/api.ts, which imports THIS module (for `rebaseWindDownTitle`) — so this
 * module cannot import windDownLoop.ts back without closing a cycle between modules
 * that all prepare SQLite statements at import time, which is a boot-order failure.
 * index.ts already imports both and registers the real applier at boot; tests
 * register a fake. When nothing is registered (e.g. before boot wiring runs), the
 * title step is silently skipped rather than crashing.
 */
export type WindDownTitleApplier = (active: boolean) => Promise<void>;
let applyTitle: WindDownTitleApplier | null = null;

export function setWindDownTitleApplier(fn: WindDownTitleApplier | null) {
  applyTitle = fn;
}

/**
 * The overlay signal (state row + broadcast) is authoritative either way; only the
 * Twitch write can fail. Never let that fail the caller or corrupt state — log it.
 *
 * Returns whether the write actually landed (true when nothing is registered — there
 * is nothing to fail), so a caller like `resetWindDownForStreamEnd` can tell a
 * successful restore from a failed one instead of assuming success.
 */
async function applyTitleSafely(active: boolean, context: string): Promise<boolean> {
  if (!applyTitle) return true;
  try {
    await applyTitle(active);
    return true;
  } catch (error) {
    console.error(`Wind-down: could not update the Twitch title (${context}):`, error);
    return false;
  }
}

export function setWindDownActive(input: { active: boolean; source: WindDownSource }): WindDownPublicState {
  const prev = getWindDownState();
  const sessionId = getCurrentStreamSessionId();

  // Only a MANUAL switch-off is the operator deciding to keep streaming, and only
  // that latches. An Action or the scheduler turning it off leaves the schedule free
  // to arm again.
  const dismissedSessionId = input.active
    ? null
    : input.source === 'manual' && sessionId
      ? sessionId
      : prev.dismissedSessionId;

  writeState({
    active: input.active,
    activatedAt: input.active ? (prev.active ? prev.activatedAt : nowIso()) : null,
    source: input.active ? input.source : null,
    sessionId: input.active ? sessionId : prev.sessionId,
    // The base title (and the suffix recorded alongside it) are owned by the loop,
    // which restores from them. Preserve both here.
    baseTitle: prev.baseTitle,
    appliedSuffix: prev.appliedSuffix,
    dismissedSessionId,
  });

  const state = getWindDownPublicState();
  broadcast('winddown:updated', state);
  return state;
}

/**
 * Persist just the base title, leaving whatever `appliedSuffix` is already stored
 * untouched. Used when the base needs correcting from something already true on
 * Twitch (a read) rather than from a write that hasn't happened — e.g. boot reconcile
 * derives a corrected base from the LIVE title and must not also claim a new suffix
 * was applied until its own Twitch write actually lands.
 */
export function setWindDownBaseTitle(baseTitle: string | null) {
  writeState({ ...getWindDownState(), baseTitle });
}

/**
 * Record the base title together with the suffix actually applied alongside it —
 * the pair the boot reconcile needs to derive an exact base from the live title
 * later, rather than guessing from whatever the suffix setting currently says.
 * `null, null` marks "nothing applied" (a completed restore).
 */
export function setWindDownTitleState(baseTitle: string | null, appliedSuffix: string | null) {
  writeState({ ...getWindDownState(), baseTitle, appliedSuffix });
}

/**
 * The stream ended. `wind_down_state.active` must not survive into the next one —
 * `evaluateWindDown` refuses to activate at all while `state.active` is true
 * ("already_active"), so a state row left over from the last stream would permanently
 * disarm the scheduler and weld the suffix onto every future title. Restore the title
 * FIRST, while the stored base title this session captured is still there to restore
 * to, then clear the row — including `dismissedSessionId`, which is scoped to the
 * session that just ended and must not carry into the next one.
 *
 * `active` always goes false here: EventSub already told us the stream is over, and
 * there is nothing left to be "active" about. But `baseTitle`/`appliedSuffix` only
 * clear when the restore write actually landed — a transient Twitch failure must not
 * make this look like nothing is left to fix, or nothing would ever retry it: not
 * `tick()` (which only reconciles while streaming) and not a redelivered
 * `stream.offline`, which just calls this again and would otherwise see a
 * `baseTitle` already wiped and no-op instead of retrying.
 */
export async function resetWindDownForStreamEnd(): Promise<void> {
  const restored = await applyTitleSafely(false, 'stream end');
  const current = getWindDownState();
  writeState({
    active: false,
    activatedAt: null,
    source: null,
    sessionId: null,
    baseTitle: restored ? null : current.baseTitle,
    appliedSuffix: restored ? null : current.appliedSuffix,
    dismissedSessionId: null,
  });
  broadcastWindDown();
}

/** Return value of `rebaseWindDownTitle` — see Finding 7 below for why the suffix rides along. */
export type RebasedWindDownTitle = {
  /** What the caller should actually send to Twitch. */
  titleToSend: string;
  /**
   * The suffix used to compute `titleToSend`, or null when there was nothing to
   * rebase (wind-down inactive, or the title effect disabled) — pass this straight
   * through to `commitWindDownRebase` unchanged rather than letting it re-read
   * settings itself.
   */
  suffixUsed: string | null;
};

/**
 * Re-base a title the operator submitted while wind-down is active.
 *
 * They are editing the suffixed title they can SEE, so storing their submission
 * verbatim would make the next compose append a second suffix. Returns what should
 * actually be sent to Twitch.
 *
 * Pure — does NOT persist anything. Write-then-persist: the caller (twitch/api.ts)
 * sends this title to Twitch first and only calls `commitWindDownRebase` once that
 * PATCH has actually confirmed, so a failed write never leaves a base recorded that
 * was never applied. See `commitWindDownRebase` below for the persistence half.
 *
 * Invariant (Finding 7): the suffix used here is threaded through to
 * `commitWindDownRebase` as `suffixUsed` rather than being re-read from settings a
 * second time. The two used to read `getWindDownSettings()` independently; a
 * settings save (the operator editing the suffix text) landing in the window
 * between this call and the PATCH it feeds actually confirming would let commit
 * persist a DIFFERENT suffix than the one this function actually composed into
 * `titleToSend` — recording a base/appliedSuffix pair that describes a title that
 * was never sent to Twitch. Passing the same value forward makes that impossible.
 *
 * Lives here rather than in windDownLoop.ts on purpose: twitch/api.ts calls this, and
 * windDownLoop.ts imports twitch/api.ts, so putting it there would make a cycle
 * between two modules that both prepare statements at load time.
 */
export function rebaseWindDownTitle(submittedTitle: string): RebasedWindDownTitle {
  const state = getWindDownState();
  if (!state.active) return { titleToSend: submittedTitle, suffixUsed: null };

  const settings = getWindDownSettings();
  if (!settings.titleEnabled) return { titleToSend: submittedTitle, suffixUsed: null };

  const base = stripWindDownSuffix(submittedTitle, settings.titleSuffix);
  return { titleToSend: composeWindDownTitle(base, settings.titleSuffix), suffixUsed: settings.titleSuffix };
}

/**
 * The persistence half of `rebaseWindDownTitle`. Call this ONLY after the Twitch PATCH
 * built from `rebaseWindDownTitle`'s return value has actually confirmed — recomputes
 * the same base from `submittedTitle` (the operator's original submission, not the
 * composed title that was sent), using `suffixUsed` exactly as `rebaseWindDownTitle`
 * returned it (Finding 7) rather than re-reading settings, which could have changed
 * in the interim. `suffixUsed === null` means `rebaseWindDownTitle` already decided
 * there was nothing to rebase — nothing to commit either. The `active` check still
 * covers a DIFFERENT race than the suffix one: wind-down being switched off entirely
 * while the PATCH was in flight already ran its own restore off the previous base,
 * so committing a new one here would leave a base recorded while inactive.
 */
export function commitWindDownRebase(submittedTitle: string, suffixUsed: string | null): void {
  if (suffixUsed === null) return;
  if (!getWindDownState().active) return;

  const base = stripWindDownSuffix(submittedTitle, suffixUsed);
  setWindDownTitleState(base, suffixUsed);
}

/**
 * The GET is on the overlay token's read allowlist so a browser source can seed
 * itself. The PUT is operator-only — the overlay token is GET-only by construction,
 * so a browser source cannot switch wind-down on for the whole channel.
 */
export function registerWindDownRoutes(app: express.Express) {
  app.get('/api/wind-down', (_request, response) => {
    response.json(getWindDownPublicState());
  });

  app.put('/api/wind-down', handle(async (request, response) => {
    const active = (request.body as { active?: unknown } | null)?.active === true;
    const state = setWindDownActive({ active, source: 'manual' });
    // Both directions: switching on suffixes the title, switching off must actually
    // take it back off rather than leaving it welded to the title forever.
    await applyTitleSafely(active, 'manual toggle');
    response.json(state);
  }));

  app.get('/api/wind-down/settings', (_request, response) => {
    response.json(getWindDownSettings());
  });

  app.put('/api/wind-down/settings', handle((request, response) => {
    response.json(saveWindDownSettings(request.body));
  }));

  app.get('/api/stream-session/planned-end', (_request, response) => {
    const body: PlannedStreamEnd = { plannedEndAt: getPlannedStreamEnd() };
    response.json(body);
  });

  app.put('/api/stream-session/planned-end', handle((request, response) => {
    const sessionId = getCurrentStreamSessionId();
    if (!sessionId) throw new HttpRouteError(409, NO_ACTIVE_SESSION_FOR_PLANNED_END);

    const raw = (request.body as Partial<PlannedStreamEnd> | null)?.plannedEndAt;
    if (raw === null || raw === undefined || raw === '') {
      setPlannedStreamEnd(sessionId, null);
      broadcastWindDown();
      const body: PlannedStreamEnd = { plannedEndAt: null };
      response.json(body);
      return;
    }

    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) throw new HttpRouteError(400, 'Planned end time is not a valid date.');

    const plannedEndAt = parsed.toISOString();
    setPlannedStreamEnd(sessionId, plannedEndAt);
    // The overlay countdown reads plannedEndAt off this event, so changing the plan
    // has to re-broadcast or a running countdown keeps the old target.
    broadcastWindDown();
    const body: PlannedStreamEnd = { plannedEndAt };
    response.json(body);
  }));
}
