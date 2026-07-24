import type { TemplateContext, TriggerCondition } from '../shared/api';
import { normalizeProfileTag } from '../shared/viewerTags';

/** A conditions array whose JSON could not be parsed. Reference-compared; makes the
 *  trigger fail closed (never fire) rather than firing with no filter. */
export const CONDITIONS_UNREADABLE: TriggerCondition[] = Object.freeze([]) as unknown as TriggerCondition[];

const lc = (v: unknown): string => String(v ?? '').toLowerCase();

/** Inbound {data.*} keys live in a nested `data` object on the context, so a
 *  `data.<key>` condition field cannot be read by the flat property lookup every
 *  other field uses. A non-scalar coerces to the same JSON form {data.*} renders,
 *  so a condition and a template agree and `contains` never sees [object Object].
 *  A missing key stays `undefined`, preserving the fail-closed rule for every op. */
const DATA_FIELD_PATTERN = /^data\.(.+)$/;

function fieldValue(context: TemplateContext, field: string): unknown {
  const dataMatch = DATA_FIELD_PATTERN.exec(field);
  if (dataMatch) {
    const raw = context.data?.[dataMatch[1]!];
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
    try {
      return JSON.stringify(raw);
    } catch {
      return undefined;
    }
  }
  return (context as Record<string, unknown>)[field];
}

function passes(condition: TriggerCondition, context: TemplateContext): boolean {
  const { field, op, value } = condition;
  if (op === 'role_is') return (context.roles ?? []).includes(value as never);
  // normalizeProfileTag preserves case (an operator's own capitalization is part of the
  // label), so the comparison lowercases explicitly afterward — same convention as
  // tagGateAllows in viewerTags.ts.
  if (op === 'tag_has') return (context.tags ?? []).map(tag => lc(normalizeProfileTag(tag))).includes(lc(normalizeProfileTag(String(value))));

  const raw = fieldValue(context, field);
  if (raw === undefined || raw === null) return false; // missing field → false, incl. neq

  switch (op) {
    case 'eq': return lc(raw) === lc(value);
    case 'neq': return lc(raw) !== lc(value);
    case 'contains': return lc(raw).includes(lc(value));
    case 'starts_with': return lc(raw).startsWith(lc(value));
    case 'gte': { const a = Number(raw), b = Number(value); return !Number.isNaN(a) && !Number.isNaN(b) && a >= b; }
    case 'lte': { const a = Number(raw), b = Number(value); return !Number.isNaN(a) && !Number.isNaN(b) && a <= b; }
    case 'in': return Array.isArray(value) && value.map(lc).includes(lc(raw));
    default: return false;
  }
}

export function evaluateConditions(conditions: TriggerCondition[], context: TemplateContext): boolean {
  // Fail closed against the parse sentinel AND any non-array (e.g. a hand-tampered
  // conditions_json of `{}` or `"x"`): `.every` on a non-array would throw, so guarding
  // here keeps this pure function total no matter what the caller hands it.
  if (conditions === CONDITIONS_UNREADABLE || !Array.isArray(conditions)) return false;
  return conditions.every(condition => passes(condition, context));
}
