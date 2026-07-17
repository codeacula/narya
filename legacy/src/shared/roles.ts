export type Role = 'broadcaster' | 'moderator' | 'vip' | 'subscriber' | 'regular';
export type ViewerRole = 'broadcaster' | 'mod' | 'vip' | 'sub';

export function getRoleFromBadges(badges: Record<string, string> | null): Role {
  if (!badges) return 'regular';
  if (badges.broadcaster) return 'broadcaster';
  if (badges.moderator) return 'moderator';
  if (badges.vip) return 'vip';
  if (badges.subscriber) return 'subscriber';
  return 'regular';
}

export function getViewerRolesFromBadges(badges: Record<string, string> | null): ViewerRole[] {
  if (!badges) return [];
  const roles: ViewerRole[] = [];
  if (badges.broadcaster) roles.push('broadcaster');
  if (badges.moderator) roles.push('mod');
  if (badges.vip) roles.push('vip');
  if (badges.subscriber) roles.push('sub');
  return roles;
}

// Highlight ladder for a chat entry, shared by the dashboard live handler and
// the server chat projection so they can't drift. Matches ChatEntry['highlight'].
export type ChatHighlight = 'first-session' | 'first-ever' | 'broadcaster' | 'sub' | 'mod' | 'vip' | undefined;

export function chatHighlight(
  badges: Record<string, string> | null,
  isFirstEver: boolean,
  isFirstThisSession: boolean,
): ChatHighlight {
  if (isFirstEver) return 'first-ever';
  if (isFirstThisSession) return 'first-session';
  if (badges?.broadcaster) return 'broadcaster';
  if (badges?.moderator) return 'mod';
  if (badges?.vip) return 'vip';
  if (badges?.subscriber) return 'sub';
  return undefined;
}
