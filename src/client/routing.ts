export type DashboardRoute =
  | 'dashboard'
  | 'viewers'
  | 'viewer'
  | SettingsRoute;

/**
 * The sections of the settings area. Each one is a rail entry in `SettingsShell` and
 * its own URL, so a section is linkable and the browser's back button works between
 * them. `settings` is the landing section (Connections) and owns the bare /settings.
 */
export type SettingsRoute =
  | 'settings'
  | 'golive'
  | 'winddown'
  | 'categories'
  | 'rewards'
  | 'actions'
  | 'automation'
  | 'modules'
  | 'content'
  | 'speech'
  | 'ai';

/** The browser-source widgets. `main.tsx` maps each to a component. */
export type OverlayName =
  | 'frame'
  | 'chat'
  | 'nowplaying'
  | 'sounds'
  | 'shoutouts'
  | 'clips'
  | 'status'
  | 'text'
  | 'winddown';

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
  '/overlay/winddown': 'winddown',
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

/**
 * One table for both directions, so a route's path and its parse can't drift apart.
 * `viewer` is absent: its path carries a login segment (see `pathForViewer`).
 */
const PATH_BY_ROUTE: Record<Exclude<DashboardRoute, 'viewer'>, string> = {
  dashboard: '/dashboard',
  viewers: '/viewers',
  settings: '/settings',
  golive: '/settings/go-live',
  winddown: '/settings/wind-down',
  categories: '/settings/categories',
  rewards: '/settings/rewards',
  actions: '/settings/actions',
  automation: '/settings/automation',
  modules: '/settings/modules',
  content: '/settings/content',
  speech: '/settings/speech',
  ai: '/settings/ai',
};

const ROUTE_BY_PATH = new Map<string, DashboardRoute>(
  Object.entries(PATH_BY_ROUTE).map(([route, path]) => [path, route as DashboardRoute]),
);

const SETTINGS_ROUTES: ReadonlySet<string> = new Set<SettingsRoute>([
  'settings', 'golive', 'winddown', 'categories', 'rewards', 'actions', 'automation', 'modules', 'content', 'speech', 'ai',
]);

/** Whether a route lives inside the settings shell — which is what lights the top nav's settings link. */
export function isSettingsRoute(route: DashboardRoute): route is SettingsRoute {
  return SETTINGS_ROUTES.has(route);
}

export function dashboardRouteFromPath(pathname: string): DashboardRoute {
  const path = normalizePath(pathname);
  // A single-viewer detail page: /viewers/<login>
  if (path.startsWith('/viewers/') && path.slice('/viewers/'.length).length > 0) return 'viewer';
  return ROUTE_BY_PATH.get(path) ?? 'dashboard';
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
  // A bare 'viewer' has no login to route to; the list is the honest destination.
  if (route === 'viewer') return PATH_BY_ROUTE.viewers;
  return PATH_BY_ROUTE[route];
}

/** Narrow an arbitrary string (a nav click) to a route, falling back to the dashboard. */
export function dashboardRouteFromName(name: string): DashboardRoute {
  return name in PATH_BY_ROUTE || name === 'viewer' ? name as DashboardRoute : 'dashboard';
}
