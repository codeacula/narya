/**
 * Viewer profile tags, shared by the Viewer Profile modal, the LLM step's targeting
 * editors, and the server-side gate that enforces them.
 *
 * Normalization deliberately PRESERVES case — the operator's own capitalization is
 * part of the label they see. Every comparison therefore lowercases explicitly; a
 * gate that compared raw strings would let a tag saved "No-LLM" slip past a rule
 * written "no-llm", and it would fail open and silently.
 */

export const MAX_VIEWER_TAGS = 12;

const MAX_TAG_LENGTH = 32;

export function normalizeProfileTag(value: string): string {
  return value.trim().replace(/^#/, '').slice(0, MAX_TAG_LENGTH);
}

export function addProfileTag(tags: string[], value: string): string[] {
  const tag = normalizeProfileTag(value);
  if (!tag || tags.length >= MAX_VIEWER_TAGS) return tags;
  const existing = new Set(tags.map(item => item.toLowerCase()));
  if (existing.has(tag.toLowerCase())) return tags;
  return [...tags, tag];
}

/**
 * Deny beats allow, and an empty allow list admits everyone.
 *
 * An invocation with no tags — no login, so no profile — passes a deny list but is
 * REJECTED by an allow list. That asymmetry is deliberate: "only these tags" does not
 * describe an anonymous run.
 */
export function tagGateAllows(viewerTags: string[], allowTags: string[], denyTags: string[]): boolean {
  const held = new Set(viewerTags.map(tag => normalizeProfileTag(tag).toLowerCase()).filter(Boolean));
  const deny = denyTags.map(tag => normalizeProfileTag(tag).toLowerCase()).filter(Boolean);
  if (deny.some(tag => held.has(tag))) return false;
  const allow = allowTags.map(tag => normalizeProfileTag(tag).toLowerCase()).filter(Boolean);
  if (allow.length === 0) return true;
  return allow.some(tag => held.has(tag));
}
