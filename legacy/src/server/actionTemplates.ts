import type { TemplateContext } from '../shared/api';

// Tokens an Action template may interpolate. {arg1}, {arg2}… index into args and
// are handled separately because their names are open-ended.
const TOKEN_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
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
 * Interpolate a TemplateContext into an Action template.
 *
 * A *known* token whose field is absent renders as an empty string, never the
 * literal token, so a follow alert reusing a template with {months} degrades
 * quietly. An *unknown* token is left intact so an operator's typo stays visible.
 *
 * Single-pass: an interpolated value that itself contains "{actor}" — chat text is
 * attacker-controlled — is never re-expanded.
 */
export function renderActionTemplate(template: string, context: TemplateContext): string {
  if (!template) return '';
  return template.replace(TOKEN_PATTERN, (match, token: string) => {
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
