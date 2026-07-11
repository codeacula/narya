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

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
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
