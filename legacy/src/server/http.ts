import type express from 'express';

export class HttpRouteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map((cookie) => {
      const [rawName, ...rawValue] = cookie.trim().split('=');
      return [rawName, decodeURIComponent(rawValue.join('='))];
    }).filter(([name]) => Boolean(name)),
  );
}

export async function readResponseError(response: Response, fallback: string): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch (textError) {
    console.error('HTTP: failed to read error response text:', textError);
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? text.trim() ?? fallback;
  } catch {
    return text.trim() || fallback;
  }
}

export function parseJsonColumn<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error('HTTP: failed to parse JSON column:', error);
    return null;
  }
}

export function sendRouteError(response: express.Response, error: unknown) {
  if (error instanceof HttpRouteError) {
    response.status(error.status).json({ error: error.message });
    return;
  }

  console.error('Route error:', error);
  response.status(500).json({ error: 'Internal server error' });
}
