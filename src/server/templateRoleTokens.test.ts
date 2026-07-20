import { expect, test } from 'bun:test';
import { renderActionTemplate } from './actionTemplates';

test('{role} renders the actor role', () => {
  expect(renderActionTemplate('hi {role}', { role: 'mod' })).toBe('hi mod');
});

test('{tags} renders a comma-separated list', () => {
  expect(renderActionTemplate('{tags}', { tags: ['vip', 'artist'] })).toBe('vip, artist');
});

test('{role} and {tags} render empty when absent, like {months} outside a resub', () => {
  expect(renderActionTemplate('[{role}][{tags}]', {})).toBe('[][]');
});

test('an empty tag list renders empty rather than the literal token', () => {
  expect(renderActionTemplate('[{tags}]', { tags: [] })).toBe('[]');
});
