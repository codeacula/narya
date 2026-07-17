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
