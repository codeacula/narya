import type { Viewer } from '../../../shared/api';

/**
 * The line icon (ui/icons.tsx) drawn in each role's badge square. Icons, not text
 * glyphs: a '⚔' or '★' renders in whatever font the system falls back to, at that
 * font's weight, so the four badges never matched. Sub uses the sub alert's planet,
 * so a subscriber reads the same here as on the overlay.
 */
export const ROLE_BADGE: Record<string, string> = {
  broadcaster: 'broadcast',
  mod: 'swords',
  vip: 'star',
  sub: 'planet',
};

/** The badge's accessible name and tooltip. */
export const ROLE_BADGE_LABEL: Record<string, string> = {
  broadcaster: 'Broadcaster',
  mod: 'Moderator',
  vip: 'VIP',
  sub: 'Subscriber',
};

export function badgesFor(viewer: Viewer | undefined): string[] {
  if (!viewer) return [];
  const out: string[] = [];
  if (viewer.roles.includes('broadcaster')) out.push('broadcaster');
  if (viewer.roles.includes('mod')) out.push('mod');
  if (viewer.roles.includes('vip')) out.push('vip');
  if (viewer.roles.includes('sub')) out.push('sub');
  return out;
}
