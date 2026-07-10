export type DashboardRoute = 'dashboard' | 'settings' | 'rewards' | 'categories' | 'viewers';

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function dashboardRouteFromPath(pathname: string): DashboardRoute {
  const path = normalizePath(pathname);
  if (path === '/settings/rewards') return 'rewards';
  if (path === '/settings/categories') return 'categories';
  if (path === '/viewers') return 'viewers';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}

export function pathForDashboardRoute(route: DashboardRoute): string {
  if (route === 'settings') return '/settings';
  if (route === 'rewards') return '/settings/rewards';
  if (route === 'categories') return '/settings/categories';
  if (route === 'viewers') return '/viewers';
  return '/dashboard';
}
