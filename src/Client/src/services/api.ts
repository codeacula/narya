// Thin fetch wrapper: attaches the dashboard token, parses JSON, and — on the
// one response shape the auth middleware uses to say "the token itself is bad"
// (401 + {code:"INVALID_DASHBOARD_TOKEN"}, see DashboardTokenMiddleware) —
// discards the stored token so the app doesn't keep retrying with a dead one.
//
// A bare 401 elsewhere (or a 403 for an overlay-scoped path) is NOT treated as
// a token rejection: matching on the server's code, not the status alone,
// mirrors legacy's isDashboardTokenRejection (legacy/src/client/auth.ts).

import { authHeaders, clearDashboardToken } from './auth'
import type { AppConfigPatch, AppConfigResponse, HealthResponse } from '../types'

export const INVALID_DASHBOARD_TOKEN = 'INVALID_DASHBOARD_TOKEN'

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Thrown specifically when the server rejected the stored dashboard token. */
export class DashboardTokenInvalidError extends ApiError {
  constructor(message: string) {
    super(401, INVALID_DASHBOARD_TOKEN, message)
    this.name = 'DashboardTokenInvalidError'
  }
}

interface ErrorBody {
  error?: string
  code?: string
  errors?: string[]
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...init.headers,
    },
  })

  const body = await parseJson(response)

  if (!response.ok) {
    const errorBody = (body ?? {}) as ErrorBody
    if (response.status === 401 && errorBody.code === INVALID_DASHBOARD_TOKEN) {
      clearDashboardToken()
      throw new DashboardTokenInvalidError(errorBody.error ?? 'Dashboard token was rejected')
    }
    const message = errorBody.errors?.join(', ') ?? errorBody.error ?? response.statusText
    throw new ApiError(response.status, errorBody.code, message)
  }

  return body as T
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health')
}

export function getConfig(): Promise<AppConfigResponse> {
  return request<AppConfigResponse>('/api/config')
}

export function putConfig(patch: AppConfigPatch): Promise<AppConfigResponse> {
  return request<AppConfigResponse>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}
