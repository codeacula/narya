import { describe, it, expect, beforeEach } from 'vitest'

import { captureDashboardToken, getDashboardToken } from '../services/auth'

describe('captureDashboardToken', () => {
  beforeEach(() => localStorage.clear())

  it('stores the token from the query string and strips it from the URL', () => {
    history.replaceState(null, '', '/?token=abc123')
    captureDashboardToken()
    expect(getDashboardToken()).toBe('abc123')
    expect(location.search).not.toContain('abc123')
  })

  it('keeps a previously stored token when the URL has none', () => {
    localStorage.setItem('dashboardToken', 'kept')
    history.replaceState(null, '', '/')
    captureDashboardToken()
    expect(getDashboardToken()).toBe('kept')
  })
})
