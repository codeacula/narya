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
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch (error) {
    console.error('HTTP: failed to parse error response JSON:', error);
    try {
      const text = await response.text();
      return text.trim() || fallback;
    } catch (textError) {
      console.error('HTTP: failed to read error response text:', textError);
      return fallback;
    }
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
