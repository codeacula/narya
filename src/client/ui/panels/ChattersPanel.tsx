import type { Viewer, Chatter } from '../../../shared/api';
import { badgesFor, ROLE_BADGE } from './badges';

const ROLE_SORT_ORDER: Record<string, number> = { broadcaster: 0, mod: 1, vip: 2, sub: 3 };

/** A person who recently sent a chat message, stamped with when, for {@link mergeRecentChatters}. */
export type RecentChatter = { chatter: Chatter; at: number };

/**
 * Folds people who just chatted into Twitch's presence list. Twitch's `chat/chatters`
 * endpoint lags brand-new arrivals, but a chat message is proof someone is here, so
 * recent senders show immediately. When Twitch does list them its row wins (it carries
 * the real user id); senders quiet longer than `ttlMs` age out so leavers don't linger.
 */
export function mergeRecentChatters(
  present: Chatter[],
  recent: RecentChatter[],
  now: number,
  ttlMs: number,
): Chatter[] {
  const byLogin = new Map<string, Chatter>();
  for (const chatter of present) byLogin.set(chatter.userLogin.toLowerCase(), chatter);
  for (const { chatter, at } of recent) {
    if (now - at > ttlMs) continue;
    const login = chatter.userLogin.toLowerCase();
    if (!byLogin.has(login)) byLogin.set(login, chatter);
  }
  return [...byLogin.values()];
}

function chatterSortKey(chatter: Chatter, viewers: Record<string, Viewer>): number {
  const viewer = viewers[chatter.userLogin.toLowerCase()];
  if (!viewer) return 4;
  for (const role of ['broadcaster', 'mod', 'vip', 'sub']) {
    if (viewer.roles.includes(role)) return ROLE_SORT_ORDER[role] ?? 4;
  }
  return 4;
}

export function ChattersPanel({
  chatters,
  viewers,
  error,
  onOpenViewer,
}: {
  chatters: Chatter[];
  viewers: Record<string, Viewer>;
  error: string | null;
  onOpenViewer: (login: string) => void;
}) {
  if (error) {
    const isScopeError = error.toLowerCase().includes('scope') || error.toLowerCase().includes('moderator:read:chatters');
    return (
      <div className="empty-state">
        <div className="es-orb" />
        <div className="es-title">{isScopeError ? 'Permission needed' : 'Unavailable'}</div>
        <div className="es-sub">
          {isScopeError
            ? 'Reconnect Twitch and grant the moderator:read:chatters scope to view live chatters.'
            : error}
        </div>
      </div>
    );
  }

  if (chatters.length === 0) {
    return (
      <div className="empty-state">
        <div className="es-orb" />
        <div className="es-title">No chatters yet</div>
        <div className="es-sub">People in your chat room will appear here.</div>
      </div>
    );
  }

  const sorted = [...chatters].sort((a, b) => {
    const diff = chatterSortKey(a, viewers) - chatterSortKey(b, viewers);
    return diff !== 0 ? diff : a.userLogin.localeCompare(b.userLogin);
  });

  return (
    <div className="chatter-list">
      {sorted.map(chatter => {
        const viewer = viewers[chatter.userLogin.toLowerCase()];
        const badges = viewer ? badgesFor(viewer) : [];
        return (
          <div
            className="chatter-row"
            key={chatter.userId}
            onClick={() => onOpenViewer(chatter.userLogin)}
          >
            <span className="chatter-name" style={{ color: viewer?.color ?? 'var(--fg-1)' }}>
              {chatter.userName}
            </span>
            {badges.length > 0 && (
              <span className="chatter-badges">
                {badges.map(b => (
                  <span className={'cbadge ' + b} key={b} title={b}>{ROLE_BADGE[b]}</span>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
