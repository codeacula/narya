import { describe, expect, test } from 'bun:test';
import { renderActionTemplate } from './actionTemplates';

describe('renderActionTemplate', () => {
  test('substitutes actor, login, and message', () => {
    expect(renderActionTemplate('{actor} ({login}) said {message}', {
      actor: 'Sorlus',
      login: 'sorlus',
      message: 'hello there',
    })).toBe('Sorlus (sorlus) said hello there');
  });

  test('an absent field renders as an empty string, not the literal token', () => {
    // A follow alert reusing a sub template must not print "{months}" on stream.
    expect(renderActionTemplate('{actor} has been here {months} months', { actor: 'Sorlus' }))
      .toBe('Sorlus has been here  months');
  });

  test('every known token renders empty against an empty context', () => {
    const template = '{actor}{login}{message}{input}{args}{arg1}{rewardTitle}{amount}{tier}{months}{category}{module}';
    expect(renderActionTemplate(template, {})).toBe('');
  });

  test('coerces numeric fields, and keeps zero rather than blanking it', () => {
    expect(renderActionTemplate('{amount} bits, {months} months', { amount: 500, months: 0 }))
      .toBe('500 bits, 0 months');
  });

  test('{args} joins with spaces and {argN} indexes into args', () => {
    const context = { args: ['first', 'second', 'third'] };
    expect(renderActionTemplate('{args}', context)).toBe('first second third');
    expect(renderActionTemplate('{arg1}/{arg2}/{arg3}', context)).toBe('first/second/third');
  });

  test('an out-of-range {argN} renders empty', () => {
    expect(renderActionTemplate('[{arg2}]', { args: ['only'] })).toBe('[]');
    expect(renderActionTemplate('[{arg1}]', { args: [] })).toBe('[]');
  });

  test('{args} with no args renders empty', () => {
    expect(renderActionTemplate('shout {args}', {})).toBe('shout ');
  });

  test('{arg0} is not a token and is left intact', () => {
    // args are 1-indexed; {arg0} is a typo, so it stays visible.
    expect(renderActionTemplate('{arg0}', { args: ['first'] })).toBe('{arg0}');
  });

  test('leaves an unknown token intact so a typo is visible', () => {
    expect(renderActionTemplate('{actor} did {mystery}', { actor: 'Sorlus' })).toBe('Sorlus did {mystery}');
  });

  test('replaces every occurrence of a repeated token', () => {
    expect(renderActionTemplate('{actor} {actor} {actor}', { actor: 'Sorlus' })).toBe('Sorlus Sorlus Sorlus');
  });

  test('substitutes the remaining reward, subscription, and module tokens', () => {
    expect(renderActionTemplate('{rewardTitle}|{input}|{tier}|{category}|{module}', {
      rewardTitle: 'Hydrate',
      input: 'drink water',
      tier: '2000',
      category: 'Software and Game Development',
      module: 'Coding',
    })).toBe('Hydrate|drink water|2000|Software and Game Development|Coding');
  });

  test('a template with no tokens is returned unchanged', () => {
    expect(renderActionTemplate('Welcome!', { actor: 'Sorlus' })).toBe('Welcome!');
  });

  test('an interpolated value containing a token is not re-expanded', () => {
    // Chat is attacker-controlled: "{actor}" typed in chat must not resolve.
    expect(renderActionTemplate('{message}', { message: '{actor}', actor: 'Sorlus' })).toBe('{actor}');
  });
});

describe('rest tokens', () => {
  const context = { args: ['bob', '300', 'spamming', 'links'] };

  test('{rest} is everything after the first argument, so a target is not re-included', () => {
    expect(renderActionTemplate('{rest}', context)).toBe('300 spamming links');
  });

  test('{rest2} skips the duration too, which is what a timeout reason needs', () => {
    expect(renderActionTemplate('{rest2}', context)).toBe('spamming links');
  });

  test('{args} still includes everything', () => {
    expect(renderActionTemplate('{args}', context)).toBe('bob 300 spamming links');
  });

  test('a rest token past the end renders empty, not the literal token', () => {
    expect(renderActionTemplate('{rest9}', context)).toBe('');
  });
});

describe('{counter:key}', () => {
  const counters = (values: Record<string, number>) =>
    (key: string) => (key in values ? values[key] : undefined);

  test('renders a counter value', () => {
    expect(renderActionTemplate('Deaths: {counter:deaths}', {}, counters({ deaths: 42 })))
      .toBe('Deaths: 42');
  });

  test('renders zero as "0" rather than empty or literal', () => {
    // A truthiness test on the resolved value would put a raw token on the live
    // stream at exactly zero deaths.
    expect(renderActionTemplate('{counter:deaths}', {}, counters({ deaths: 0 }))).toBe('0');
  });

  test('renders a negative value', () => {
    expect(renderActionTemplate('{counter:net}', {}, counters({ net: -3 }))).toBe('-3');
  });

  test('leaves an unknown key as a literal token so a typo stays visible', () => {
    expect(renderActionTemplate('{counter:typo}', {}, counters({ deaths: 1 })))
      .toBe('{counter:typo}');
  });

  test('leaves the token alone when no resolver is supplied', () => {
    expect(renderActionTemplate('{counter:deaths}', {})).toBe('{counter:deaths}');
  });

  test('renders several counters and other tokens in one template', () => {
    expect(renderActionTemplate(
      '{actor} died. Deaths: {counter:deaths}, wipes: {counter:wipes}',
      { actor: 'Sorlus' },
      counters({ deaths: 4, wipes: 2 }),
    )).toBe('Sorlus died. Deaths: 4, wipes: 2');
  });

  test('does not re-expand a value that looks like a token', () => {
    // Single-pass: chat text is attacker-controlled, so an interpolated value is
    // never itself re-scanned.
    expect(renderActionTemplate('{message} {counter:deaths}', { message: '{counter:deaths}' }, counters({ deaths: 5 })))
      .toBe('{counter:deaths} 5');
  });
});

describe('the widened token pattern does not change existing behavior', () => {
  test('a hyphenated brace expression still round-trips unchanged', () => {
    // {a-b} now *enters* the replace callback where it did not before; the
    // unknown-token branch must still return it verbatim.
    expect(renderActionTemplate('{a-b}', { actor: 'Sorlus' })).toBe('{a-b}');
  });

  test('a colon brace expression still round-trips unchanged', () => {
    expect(renderActionTemplate('{x:y}', {})).toBe('{x:y}');
  });

  test('a counter-shaped token with an invalid key stays literal', () => {
    expect(renderActionTemplate('{counter:Bad_Key}', {}, () => 7)).toBe('{counter:Bad_Key}');
  });

  test('the anchors still stop {arg1-x} reading as {arg1}', () => {
    expect(renderActionTemplate('{arg1-x}', { args: ['first'] })).toBe('{arg1-x}');
  });

  test('the anchors still stop {rest1-x} reading as {rest1}', () => {
    expect(renderActionTemplate('{rest1-x}', { args: ['a', 'b'] })).toBe('{rest1-x}');
  });
});
