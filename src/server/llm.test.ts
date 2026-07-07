import { describe, expect, test } from 'bun:test';
import { extractResponseText } from './llm';

describe('extractResponseText', () => {
  test('uses the top-level output_text shortcut', () => {
    expect(extractResponseText({ output_text: 'hello there' })).toBe('hello there');
  });

  test('reads output[] parts with type output_text', () => {
    const data = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'from output_text' }] }] };
    expect(extractResponseText(data)).toBe('from output_text');
  });

  test('reads output[] parts with type text (thinking models)', () => {
    const data = { output: [{ content: [{ type: 'text', text: 'from text part' }] }] };
    expect(extractResponseText(data)).toBe('from text part');
  });

  test('falls back to chat-completions choices[].message.content', () => {
    const data = { choices: [{ message: { content: 'chat completion reply' } }] };
    expect(extractResponseText(data)).toBe('chat completion reply');
  });

  test('strips <think>...</think> reasoning blocks', () => {
    expect(extractResponseText({ output_text: '<think>secret reasoning</think>visible answer' })).toBe('visible answer');
  });

  test('returns empty string when no usable content is present', () => {
    expect(extractResponseText({})).toBe('');
    expect(extractResponseText({ output_text: '   ' })).toBe('');
  });
});
