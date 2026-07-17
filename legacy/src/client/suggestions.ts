import React from 'react';

// Debounced type-ahead: waits `delayMs` after the query settles, then runs `fetcher`, with a
// cancelled-flag guard so a stale in-flight request never overwrites a newer result. Queries shorter
// than `minLength` (or a disabled hook) clear the list without hitting the network.
export function useDebouncedSuggestions<T>(
  query: string,
  fetcher: (query: string) => Promise<T[]>,
  options?: { minLength?: number; delayMs?: number; enabled?: boolean },
): { suggestions: T[]; loading: boolean } {
  const { minLength = 2, delayMs = 250, enabled = true } = options ?? {};
  const [suggestions, setSuggestions] = React.useState<T[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < minLength) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      void fetcher(trimmed)
        .then(result => { if (!cancelled) setSuggestions(result); })
        .catch((error: unknown) => {
          console.error('Failed to load suggestions:', error);
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, fetcher, minLength, delayMs, enabled]);

  return { suggestions, loading };
}

// Twitch box-art urls carry {width}x{height} placeholders; fill them for a fixed-size thumbnail.
export function formatBoxArtUrl(url: string | null, width: number, height: number): string | null {
  return url ? url.replaceAll('{width}', String(width)).replaceAll('{height}', String(height)) : null;
}
