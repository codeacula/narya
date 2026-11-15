/**
 * Relative age buckets shared by the dashboard status payload (baked at fetch
 * time) and the client, which recomputes from `receivedAt` so a rendered age
 * doesn't go stale between refreshes. Both must agree on the wording.
 */
export function formatAgo(receivedAt: string): string {
  const diffMs = Date.now() - new Date(receivedAt).getTime();
  const totalSecs = Math.max(0, Math.floor(diffMs / 1000));
  if (totalSecs < 60) return 'just now';
  // Always unit-suffixed. A bare "15:27" sat beside chat's wall-clock "6:07 PM" and
  // read as a time of day when it meant fifteen minutes ago.
  if (totalSecs < 3600) return `${Math.floor(totalSecs / 60)}m ago`;
  if (totalSecs < 86_400) {
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    return mins === 0 ? `${hours}h ago` : `${hours}h ${mins}m ago`;
  }
  const days = Math.floor(totalSecs / 86_400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
