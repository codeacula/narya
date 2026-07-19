import type { TemplateContext } from '../shared/api';

// Tokens an Action template may interpolate. {arg1}, {arg2}… index into args and
// are handled separately because their names are open-ended.
//
// ':' and '-' are admitted for {counter:some-key}. Widening the class is safe by
// construction: neither '{' nor '}' is in it, so a match's extent is fixed by its
// opening brace and the next closing one, independent of what the class allows.
// Widening therefore cannot change an existing match's extent or let a new match
// cannibalize an old one — strings like {a-b} merely start *entering* the callback,
// where the unknown branch returns them verbatim.
//
// That identity holds ONLY because the unknown branch below returns `match` rather
// than ''. The widening and the leave-typos-visible rule are now coupled.
const TOKEN_PATTERN = /\{([A-Za-z][A-Za-z0-9:-]*)\}/g;
// {counter:some-key}. The key grammar matches counters.ts's normalizeCounterKey.
const COUNTER_TOKEN_PATTERN = /^counter:([a-z0-9-]+)$/;
const ARG_TOKEN_PATTERN = /^arg([1-9][0-9]*)$/;
// {rest} / {restN}: every argument from position N onward, joined. {rest} is {rest1}.
// This is what makes "target and remainder" commands expressible — `/whisper bob hi
// there` binds {arg1} as the target and {rest1} as the message, where {args} would
// wrongly re-include the target.
const REST_TOKEN_PATTERN = /^rest([1-9][0-9]*)?$/;

function scalar(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? String(value) : value;
}

function resolveToken(token: string, context: TemplateContext): string | undefined {
  switch (token) {
    case 'actor': return scalar(context.actor);
    case 'login': return scalar(context.login);
    case 'message': return scalar(context.message);
    case 'input': return scalar(context.input);
    case 'args': return context.args ? context.args.join(' ') : undefined;
    case 'rewardTitle': return scalar(context.rewardTitle);
    case 'amount': return scalar(context.amount);
    case 'tier': return scalar(context.tier);
    case 'months': return scalar(context.months);
    case 'category': return scalar(context.category);
    case 'module': return scalar(context.module);
    default: break;
  }

  const argMatch = ARG_TOKEN_PATTERN.exec(token);
  if (argMatch) {
    // Known-shaped but out of range still renders empty rather than the literal token.
    return context.args?.[Number(argMatch[1]) - 1] ?? '';
  }

  const restMatch = REST_TOKEN_PATTERN.exec(token);
  if (restMatch) {
    const from = Number(restMatch[1] ?? '1');
    return context.args ? context.args.slice(from).join(' ') : undefined;
  }

  return undefined;
}

/**
 * Looks up a counter's current value by key, or undefined when no such counter
 * exists.
 *
 * Injected rather than imported so this module stays free of the database and
 * unit-testable without one. It must be SYNCHRONOUS (a String.replace callback
 * cannot await) and it must be a live lookup rather than a snapshot map, because
 * an Action whose first step increments a counter and whose second step displays
 * it has to see the incremented value.
 */
export type CounterResolver = (key: string) => number | undefined;

/**
 * Expand ONLY {counter:key}, leaving every other brace expression exactly as
 * typed.
 *
 * For text that is not an Action template. The stream status line is freeform —
 * the operator, or an external system, may put anything in it — and it has no
 * invocation behind it. Running it through renderActionTemplate would resolve
 * {actor} and {amount} against an empty context and silently delete them, turning
 * "Shoutout to {actor}" into "Shoutout to ". The absent-field-renders-empty rule
 * earns its keep inside an Action, where a real context exists and a missing
 * field is genuinely missing; applied here it just eats the operator's text.
 */
export function renderCounterTokens(text: string, resolveCounter: CounterResolver): string {
  if (!text) return '';
  return text.replace(TOKEN_PATTERN, (match, token: string) => {
    const counterMatch = COUNTER_TOKEN_PATTERN.exec(token);
    if (!counterMatch) return match;
    const value = resolveCounter(counterMatch[1]!);
    return value === undefined ? match : String(value);
  });
}

/**
 * Interpolate a TemplateContext into an Action template.
 *
 * A *known* token whose field is absent renders as an empty string, never the
 * literal token, so a follow alert reusing a template with {months} degrades
 * quietly. An *unknown* token is left intact so an operator's typo stays visible.
 *
 * {counter:some-key} follows the *unknown-token* rule rather than the absent-field
 * one: a key with no counter behind it renders literally, because a silently empty
 * "Deaths: " on stream reads as a bug in the overlay rather than a missing counter.
 * Deleting a referenced counter is blocked in counters.ts so this stays rare.
 *
 * Single-pass: an interpolated value that itself contains "{actor}" — chat text is
 * attacker-controlled — is never re-expanded.
 */
export function renderActionTemplate(
  template: string,
  context: TemplateContext,
  resolveCounter?: CounterResolver,
): string {
  if (!template) return '';
  return template.replace(TOKEN_PATTERN, (match, token: string) => {
    const counterMatch = COUNTER_TOKEN_PATTERN.exec(token);
    if (counterMatch) {
      // Compared against undefined, not tested for truthiness: a counter legitimately
      // sits at 0 or below, and `value ? … : match` would put a literal
      // "{counter:deaths}" on the live stream at exactly zero deaths.
      const value = resolveCounter?.(counterMatch[1]!);
      return value === undefined ? match : String(value);
    }
    const known = isKnownToken(token);
    if (!known) return match;
    return resolveToken(token, context) ?? '';
  });
}

function isKnownToken(token: string): boolean {
  switch (token) {
    case 'actor':
    case 'login':
    case 'message':
    case 'input':
    case 'args':
    case 'rest':
    case 'rewardTitle':
    case 'amount':
    case 'tier':
    case 'months':
    case 'category':
    case 'module':
      return true;
    default:
      return ARG_TOKEN_PATTERN.test(token) || REST_TOKEN_PATTERN.test(token);
  }
}
