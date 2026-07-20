import { expect, test } from 'bun:test';
import { normalizeStepPayloadForTest, withLlmPayloadDefaults } from './actions';

test('a legacy payload keeps its template and gains every new field', () => {
  const filled = withLlmPayloadDefaults({ template: 'Answer {actor}' });
  expect(filled.template).toBe('Answer {actor}');
  expect(filled.systemPrompt).toBe('');
  expect(filled.systemPromptMode).toBe('enhance');
  expect(filled.chatHistoryLines).toBe(0);
  expect(filled.interactionHistory).toBe(0);
  expect(filled.examples).toEqual([]);
  expect(filled.allowTags).toEqual([]);
  expect(filled.denyTags).toEqual([]);
  expect(filled.allowDecline).toBe(false);
});

test('mention defaults to true so existing steps keep their @mention', () => {
  // formatPonderReply prefixes @displayName unconditionally today. Defaulting this to
  // false would silently strip the mention from every step the operator already has.
  expect(withLlmPayloadDefaults({ template: 'x' }).mention).toBe(true);
});

test('stored values win over defaults', () => {
  const filled = withLlmPayloadDefaults({
    template: 'x',
    systemPrompt: 'Be terse.',
    systemPromptMode: 'override',
    chatHistoryLines: 10,
    interactionHistory: 3,
    examples: [{ input: 'hi', output: 'hello' }],
    allowTags: ['vip'],
    denyTags: ['no-llm'],
    allowDecline: true,
    mention: false,
  });
  expect(filled.systemPrompt).toBe('Be terse.');
  expect(filled.systemPromptMode).toBe('override');
  expect(filled.chatHistoryLines).toBe(10);
  expect(filled.interactionHistory).toBe(3);
  expect(filled.examples).toEqual([{ input: 'hi', output: 'hello' }]);
  expect(filled.allowTags).toEqual(['vip']);
  expect(filled.denyTags).toEqual(['no-llm']);
  expect(filled.allowDecline).toBe(true);
  expect(filled.mention).toBe(false);
});

test('a corrupt mode falls back to enhance rather than propagating garbage', () => {
  expect(withLlmPayloadDefaults({ template: 'x', systemPromptMode: 'nonsense' }).systemPromptMode).toBe('enhance');
});

test('a system prompt over the cap is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    systemPrompt: 'y'.repeat(2001),
  })).toThrow(/2000 characters or fewer/);
});

test('too many chat lines is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    chatHistoryLines: 51,
  })).toThrow(/at most 50 chat lines/);
});

test('too many replayed interactions is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    interactionHistory: 21,
  })).toThrow(/at most 20 prior interactions/);
});

test('too many examples is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    examples: Array.from({ length: 11 }, () => ({ input: 'a', output: 'b' })),
  })).toThrow(/at most 10 examples/);
});

test('an over-long example side is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    examples: [{ input: 'a'.repeat(501), output: 'b' }],
  })).toThrow(/500 characters or fewer/);
});

test('too many gate tags is rejected', () => {
  expect(() => normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    denyTags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
  })).toThrow(/at most 20 tags/);
});

test('gate tags are normalized on the way in', () => {
  const saved = normalizeStepPayloadForTest('llm_response', {
    template: 'x',
    denyTags: [' #No-LLM ', ''],
  }) as { denyTags: string[] };
  expect(saved.denyTags).toEqual(['No-LLM']);
});
