// Client-side handling of the dashboard token. A token arrives once as a
// ?token= query param, is persisted to localStorage, and is then attached to
// API requests and the SignalR connection.
//
// Port of legacy `legacy/src/client/auth.ts`'s captureDashboardToken /
// getDashboardToken semantics. Phase 1 has no overlay token capability yet
// (that lands with the overlay client in a later phase), so there is a single
// storage key rather than legacy's page-role-keyed pair.

const TOKEN_KEY = 'dashboardToken'

/**
 * Capture a ?token= from the URL, persist it, and strip it from the address
 * bar so it doesn't linger in history/screenshots. Call once before mounting
 * the app (see main.ts). If the URL carries no token, any previously stored
 * token is left untouched.
 */
export function captureDashboardToken(): void {
  try {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (!token) return

    localStorage.setItem(TOKEN_KEY, token)

    params.delete('token')
    const query = params.toString()
    const nextUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash
    window.history.replaceState(null, '', nextUrl)
  } catch {
    // localStorage or history may be unavailable in some contexts; ignore.
  }
}

export function getDashboardToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setDashboardToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // localStorage may be unavailable; nothing to do.
  }
}

export function clearDashboardToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing to do — a token we cannot remove is one we could not have read.
  }
}

/** `Authorization: Bearer <token>` header when a token is stored, empty otherwise. */
export function authHeaders(): Record<string, string> {
  const token = getDashboardToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Build the SignalR hub URL with the token as `?access_token=`. SignalR
 * cannot attach a custom Authorization header to the WebSocket upgrade
 * request, so RealtimeHub reads the token from this query param instead
 * (see DashboardTokenAuthenticator / RealtimeHub.OnConnectedAsync).
 */
export function realtimeUrl(path: string): string {
  const token = getDashboardToken()
  if (!token) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}access_token=${encodeURIComponent(token)}`
}
