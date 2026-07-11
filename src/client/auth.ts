// Client-side handling of the shared tokens. A token arrives once as a ?token=
// query param (tablet/overlay/OBS URLs), is persisted to localStorage, and is
// then attached to API requests, the WebSocket, and OAuth links.
//
// Overlay pages get their own storage key. The dashboard and the overlays share
// an origin, so a single key would let an OBS URL's read-only overlay token
// overwrite the operator's token (or vice versa) and break whichever page loaded
// second. Keying by page role keeps the two capabilities from colliding.

const OPERATOR_TOKEN_KEY = 'dashboardToken';
const OVERLAY_TOKEN_KEY = 'overlayToken';

function tokenKey(): string {
  return window.location.pathname.startsWith('/overlay') ? OVERLAY_TOKEN_KEY : OPERATOR_TOKEN_KEY;
}

// Capture a ?token= from the URL, persist it, and strip it from the address bar
// so it doesn't linger in history/screenshots. Call once before rendering.
export function captureDashboardToken(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return;
    localStorage.setItem(tokenKey(), token);
    params.delete('token');
    const query = params.toString();
    const nextUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
    window.history.replaceState(null, '', nextUrl);
  } catch {
    // localStorage or history may be unavailable in some contexts; ignore.
  }
}

export function getDashboardToken(): string | null {
  try {
    return localStorage.getItem(tokenKey());
  } catch {
    return null;
  }
}

// Append the token as a query param when one is stored. Used for <a href> links
// and the WebSocket URL, which can't carry a custom header.
export function withToken(url: string): string {
  const token = getDashboardToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
