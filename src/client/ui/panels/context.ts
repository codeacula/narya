import type React from 'react';
import type { Viewer, ChatEntry, StreamEvent, ViewerProfileUpdate } from '../../../shared/api';

export type PanelCtx = {
  viewers: Record<string, Viewer>;
  chat: ChatEntry[];
  events: StreamEvent[];
  channel: string;
  currentSessionId: string | null;
  openViewerPopout: (login: string) => void;
  updateViewerProfile: (login: string, profile: ViewerProfileUpdate) => Promise<ViewerProfileUpdate>;
  loadOlderChat: () => Promise<boolean>;
};

export type ModuleEntry = {
  title: string;
  dot: boolean;
  footer?: boolean;
  count?: (ctx: PanelCtx) => React.ReactNode;
  render: (ctx: PanelCtx) => React.ReactNode;
};

/**
 * Whether a chat message or stream event belongs to the stream happening right
 * now. Off-stream rows (null session) and rows from an earlier session both read
 * as "past", and when nothing is live nothing is current.
 */
export function belongsToCurrentSession(sessionId: string | null | undefined, currentSessionId: string | null): boolean {
  if (currentSessionId === null) return false;
  return sessionId === currentSessionId;
}

/** A row that carries no session of its own can't mark where a session begins. */
export type SessionRow = { sessionId?: string | null; sessionless?: boolean };

/**
 * Index of the row where the session changes, or -1 when the list holds no
 * boundary to draw. One definition for both feeds, which read in opposite
 * directions: chat is oldest-first and marks where the current session begins,
 * the event feed is newest-first and marks where past streams begin.
 *
 * Rows flagged `sessionless` (whispers, which arrive live and carry no session)
 * are skipped when looking for a neighbour, so one landing mid-stream doesn't
 * read as a session change.
 *
 * `markListStart` decides whether a list that opens on the far side is itself a
 * boundary: the event feed heads a wholly-past list with "earlier streams", while
 * chat that opens in the current session has nothing above it to divide from.
 */
export function sessionBoundaryIndex(
  rows: SessionRow[],
  currentSessionId: string | null,
  options: { side: 'current' | 'past'; markListStart: boolean },
): number {
  if (currentSessionId === null) return -1;
  const wanted = options.side === 'current';
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.sessionless) continue;
    if (belongsToCurrentSession(row.sessionId, currentSessionId) !== wanted) continue;

    // Walk back past sessionless rows to the nearest neighbour that has a session.
    let previous = index - 1;
    while (previous >= 0 && rows[previous]?.sessionless) previous--;
    if (previous < 0) return options.markListStart ? index : -1;
    if (belongsToCurrentSession(rows[previous]?.sessionId, currentSessionId) === wanted) continue;
    return index;
  }
  return -1;
}
