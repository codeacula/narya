import React from 'react';
import { errorMessage } from './errors';

/**
 * What a type-ahead list shows for a query that is long enough to search.
 *
 * The rule: **a search that failed did not find nothing.** The hook used to turn a
 * failure into `[]`, so a 401 (Twitch not signed in) or a dropped network read as
 * "No matches" — telling the operator the category does not exist.
 */
export type SuggestionFace = 'searching' | 'failed' | 'none' | 'results';

export function suggestionFace({
  loading,
  error,
  count,
}: {
  loading: boolean;
  error: string | null;
  count: number;
}): SuggestionFace {
  if (loading) return 'searching';
  if (error !== null) return 'failed';
  return count > 0 ? 'results' : 'none';
}

/** The line a failed search shows in place of "No matches". */
export function suggestionFailedText(error: string): string {
  const reason = error.trim();
  if (!reason) return 'Could not search.';
  return `Could not search: ${/[.!?…]$/.test(reason) ? reason : `${reason}.`}`;
}

// Debounced type-ahead: waits `delayMs` after the query settles, then runs `fetcher`, with a
// cancelled-flag guard so a stale in-flight request never overwrites a newer result. Queries shorter
// than `minLength` (or a disabled hook) clear the list without hitting the network. A failed
// fetch clears the list and sets `error` (see `suggestionFace`); the next query clears it.
export function useDebouncedSuggestions<T>(
  query: string,
  fetcher: (query: string) => Promise<T[]>,
  options?: { minLength?: number; delayMs?: number; enabled?: boolean },
): { suggestions: T[]; loading: boolean; error: string | null } {
  const { minLength = 2, delayMs = 250, enabled = true } = options ?? {};
  const [suggestions, setSuggestions] = React.useState<T[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const trimmed = query.trim();
    setError(null);
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
        .catch((caught: unknown) => {
          if (cancelled) return;
          setSuggestions([]);
          setError(errorMessage(caught, 'Search failed'));
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, fetcher, minLength, delayMs, enabled]);

  return { suggestions, loading, error };
}

// Twitch box-art urls carry {width}x{height} placeholders; fill them for a fixed-size thumbnail.
export function formatBoxArtUrl(url: string | null, width: number, height: number): string | null {
  return url ? url.replaceAll('{width}', String(width)).replaceAll('{height}', String(height)) : null;
}
