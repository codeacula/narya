import { expect, test } from 'bun:test';
import type { ActionStepInput } from '../../../shared/api';
import { newStep, validateStep } from './automation';

function llmStep(overrides: Record<string, unknown> = {}): ActionStepInput {
  const base = newStep('llm_response');
  return { ...base, payload: { ...(base.payload as object), template: 'Answer {actor}', ...overrides } } as ActionStepInput;
}

test('a new LLM step carries every field with mention on', () => {
  const step = newStep('llm_response') as Extract<ActionStepInput, { type: 'llm_response' }>;
  expect(step.payload.mention).toBe(true);
  expect(step.payload.systemPromptMode).toBe('enhance');
  expect(step.payload.chatHistoryLines).toBe(0);
  expect(step.payload.interactionHistory).toBe(0);
  expect(step.payload.allowDecline).toBe(false);
  expect(step.payload.examples).toEqual([]);
  expect(step.payload.allowTags).toEqual([]);
  expect(step.payload.denyTags).toEqual([]);
});

test('a missing prompt is still an error', () => {
  expect(validateStep(llmStep({ template: '' }), 1)).toMatch(/needs a prompt/);
});

test('an over-long system prompt is rejected', () => {
  expect(validateStep(llmStep({ systemPrompt: 'x'.repeat(2001) }), 1)).toMatch(/2000/);
});

test('too many chat lines is rejected', () => {
  expect(validateStep(llmStep({ chatHistoryLines: 51 }), 1)).toMatch(/50/);
});

test('a negative chat line count is rejected', () => {
  expect(validateStep(llmStep({ chatHistoryLines: -1 }), 1)).toMatch(/between 0 and 50/);
});

test('too many replayed interactions is rejected', () => {
  expect(validateStep(llmStep({ interactionHistory: 21 }), 1)).toMatch(/20/);
});

test('too many examples is rejected', () => {
  expect(validateStep(llmStep({
    examples: Array.from({ length: 11 }, () => ({ input: 'a', output: 'b' })),
  }), 1)).toMatch(/10/);
});

test('an example with an empty side is rejected', () => {
  expect(validateStep(llmStep({ examples: [{ input: 'a', output: '' }] }), 1)).toMatch(/both an input and an output/);
});

test('an over-long example side is rejected', () => {
  expect(validateStep(llmStep({ examples: [{ input: 'a'.repeat(501), output: 'b' }] }), 1)).toMatch(/500/);
});

test('a valid step has no error', () => {
  expect(validateStep(llmStep({ chatHistoryLines: 10, interactionHistory: 3 }), 1)).toBeNull();
});
