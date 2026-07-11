export type DashboardRoute =
  | 'dashboard'
  | 'settings'
  | 'rewards'
  | 'categories'
  | 'viewers'
  | 'viewer'
  | 'actions'
  | 'automation'
  | 'modules';

/** The browser-source widgets. `main.tsx` maps each to a component. */
export type OverlayName =
  | 'frame'
  | 'chat'
  | 'nowplaying'
  | 'sounds'
  | 'shoutouts'
  | 'clips'
  | 'status'
  | 'text';

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

const OVERLAY_BY_PATH: Record<string, OverlayName> = {
  '/overlay': 'frame',
  '/overlay/chat': 'chat',
  '/overlay/nowplaying': 'nowplaying',
  '/overlay/sounds': 'sounds',
  '/overlay/shoutouts': 'shoutouts',
  '/overlay/clips': 'clips',
  '/overlay/status': 'status',
  '/overlay/text': 'text',
  // Retired, but deliberately still routed. Alerts became Actions, so a sub alert is
  // now a `show_text` step landing on /overlay/text. The URL, however, lives in the
  // operator's OBS scene collection, and retiring the route without redirecting it
  // dropped the browser source through to the DASHBOARD — on stream.
  //
  // Aliased to `text` and NOT to text+media on purpose: the alert's sound and clip are
  // a `play_media` step, and /overlay/clips is already a source in the same scene
  // receiving `media:play`. Rendering media here as well would play every alert twice.
  '/overlay/alerts': 'text',
};

/**
 * Which browser source a path is, or null if the path is not overlay space at all.
 *
 * Returns 'unknown' — never null — for an unrecognized path *under* /overlay, so the
 * router can render it as an inert transparent overlay. Falling through to the
 * dashboard is what put the operator's chat, controls, and viewer data on stream when
 * a retired overlay URL was still sitting in OBS.
 */
export function overlayFromPath(pathname: string): OverlayName | 'unknown' | null {
  const path = normalizePath(pathname);
  const overlay = OVERLAY_BY_PATH[path];
  if (overlay) return overlay;
  if (path === '/overlay' || path.startsWith('/overlay/')) return 'unknown';
  return null;
}

export function dashboardRouteFromPath(pathname: string): DashboardRoute {
  const path = normalizePath(pathname);
  if (path === '/settings/rewards') return 'rewards';
  if (path === '/settings/categories') return 'categories';
  if (path === '/settings/actions') return 'actions';
  if (path === '/settings/automation') return 'automation';
  if (path === '/settings/modules') return 'modules';
  if (path === '/viewers') return 'viewers';
  // A single-viewer detail page: /viewers/<login>
  if (path.startsWith('/viewers/') && path.slice('/viewers/'.length).length > 0) return 'viewer';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}

// The viewer login embedded in a /viewers/<login> path, or null for any other route.
export function viewerLoginFromPath(pathname: string): string | null {
  const path = normalizePath(pathname);
  if (!path.startsWith('/viewers/')) return null;
  const segment = path.slice('/viewers/'.length).split('/')[0];
  return segment ? decodeURIComponent(segment) : null;
}

export function pathForViewer(login: string): string {
  return `/viewers/${encodeURIComponent(login.toLowerCase())}`;
}

export function pathForDashboardRoute(route: DashboardRoute): string {
  if (route === 'settings') return '/settings';
  if (route === 'rewards') return '/settings/rewards';
  if (route === 'categories') return '/settings/categories';
  if (route === 'actions') return '/settings/actions';
  if (route === 'automation') return '/settings/automation';
  if (route === 'modules') return '/settings/modules';
  if (route === 'viewers') return '/viewers';
  if (route === 'viewer') return '/viewers';
  return '/dashboard';
}
