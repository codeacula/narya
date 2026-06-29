export type DashboardRoute = 'dashboard' | 'settings' | 'rewards';

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function dashboardRouteFromPath(pathname: string): DashboardRoute {
  const path = normalizePath(pathname);
  if (path === '/settings/rewards') return 'rewards';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}

export function pathForDashboardRoute(route: DashboardRoute): string {
  if (route === 'settings') return '/settings';
  if (route === 'rewards') return '/settings/rewards';
  return '/dashboard';
}
