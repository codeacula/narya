import { expect, test } from 'bun:test';
import type { LlmResponsePayload, TemplateContext } from '../shared/api';
import { buildLlmRequest, formatLlmReply, parseLlmReply } from './llmPrompt';

const base: LlmResponsePayload = {
  template: '',
  systemPrompt: '',
  systemPromptMode: 'enhance',
  chatHistoryLines: 0,
  interactionHistory: 0,
  examples: [],
  allowTags: [],
  denyTags: [],
  allowDecline: false,
  mention: true,
};

function build(payload: Partial<LlmResponsePayload>, context: TemplateContext = {}, extra: {
  chatLines?: Array<{ display: string; message: string }>;
  interactions?: Array<{ prompt: string; reply: string }>;
} = {}) {
  return buildLlmRequest({
    personalityPrompt: 'You are Narya.',
    payload: { ...base, ...payload },
    context,
    prompt: 'Why do people lurk?',
    chatLines: extra.chatLines ?? [],
    interactions: extra.interactions ?? [],
  });
}

test('enhance appends the step prompt to the global personality', () => {
  const { instructions } = build({ systemPrompt: 'Be terse.', systemPromptMode: 'enhance' });
  expect(instructions).toContain('You are Narya.');
  expect(instructions).toContain('Be terse.');
  expect(instructions.indexOf('You are Narya.')).toBeLessThan(instructions.indexOf('Be terse.'));
});

test('override drops the global personality entirely', () => {
  const { instructions } = build({ systemPrompt: 'Be terse.', systemPromptMode: 'override' });
  expect(instructions).not.toContain('You are Narya.');
  expect(instructions).toContain('Be terse.');
});

test('an empty step prompt under override still yields usable instructions', () => {
  // Guards against emitting an empty system prompt, which some servers reject outright.
  const { instructions } = build({ systemPrompt: '', systemPromptMode: 'override' });
  expect(instructions.trim()).not.toBe('');
});

test('the rendered prompt is always present in the input', () => {
  expect(build({}).input).toContain('Why do people lurk?');
});

test('the actor block carries display name, login, role, and tags', () => {
  const { input } = build({}, { actor: 'Bob', login: 'bob', role: 'mod', tags: ['artist'] });
  expect(input).toContain('Bob');
  expect(input).toContain('@bob');
  expect(input).toContain('mod');
  expect(input).toContain('artist');
});

test('empty sections are omitted rather than emitted as empty headers', () => {
  const { input } = build({});
  expect(input).not.toContain('Recent chat');
  expect(input).not.toContain('Earlier in your conversation');
});

test('chat lines appear when requested, oldest first', () => {
  const { input } = build(
    { chatHistoryLines: 2 },
    {},
    { chatLines: [{ display: 'Ann', message: 'hi' }, { display: 'Bo', message: 'yo' }] },
  );
  expect(input).toContain('Recent chat');
  expect(input.indexOf('hi')).toBeLessThan(input.indexOf('yo'));
});

test('prior interactions appear when requested', () => {
  const { input } = build(
    { interactionHistory: 1 },
    {},
    { interactions: [{ prompt: 'earlier question', reply: 'earlier answer' }] },
  );
  expect(input).toContain('earlier question');
  expect(input).toContain('earlier answer');
});

test('examples land in the instructions, not the input', () => {
  const { instructions, input } = build({ examples: [{ input: 'ping', output: 'pong' }] });
  expect(instructions).toContain('ping');
  expect(instructions).toContain('pong');
  expect(input).not.toContain('pong');
});

test('the decline contract appears only when declining is allowed', () => {
  expect(build({ allowDecline: false }).instructions).not.toContain('"respond"');
  expect(build({ allowDecline: true }).instructions).toContain('"respond"');
});

// --- parseLlmReply ---

test('with declining off the raw text is the message', () => {
  expect(parseLlmReply('just words', false)).toEqual({ respond: true, message: 'just words' });
});

test('with declining off a JSON-looking reply is NOT unwrapped', () => {
  // The step never asked for JSON, so this is the model's literal answer.
  expect(parseLlmReply('{"respond": true, "message": "hi"}', false).message).toBe('{"respond": true, "message": "hi"}');
});

test('bare JSON is parsed', () => {
  expect(parseLlmReply('{"respond": true, "message": "hello"}', true)).toEqual({ respond: true, message: 'hello' });
});

test('fenced JSON is parsed', () => {
  const raw = '```json\n{"respond": true, "message": "hello"}\n```';
  expect(parseLlmReply(raw, true)).toEqual({ respond: true, message: 'hello' });
});

test('JSON with prose around it is parsed', () => {
  const raw = 'Sure! {"respond": true, "message": "hello"} Hope that helps.';
  expect(parseLlmReply(raw, true).message).toBe('hello');
});

test('a message containing braces survives the balanced scan', () => {
  expect(parseLlmReply('{"respond": true, "message": "use {actor} here"}', true).message).toBe('use {actor} here');
});

test('respond:false is a decline', () => {
  expect(parseLlmReply('{"respond": false}', true).respond).toBe(false);
});

test('unparseable output falls through to the raw text rather than being swallowed', () => {
  // Local models fumble strict JSON regularly. Swallowing the reply would turn a
  // formatting quirk into a command that mysteriously stops working on stream.
  expect(parseLlmReply('I could not comply', true)).toEqual({ respond: true, message: 'I could not comply' });
});

test('valid JSON missing a message falls through to the raw text', () => {
  expect(parseLlmReply('{"respond": true}', true).message).toBe('{"respond": true}');
});

// --- formatLlmReply ---

test('mention prefixes the display name', () => {
  expect(formatLlmReply('hello', 'Bob', true)).toBe('@Bob hello');
});

test('mention off sends the reply bare', () => {
  expect(formatLlmReply('hello', 'Bob', false)).toBe('hello');
});

test('an empty mention name never yields a bare @', () => {
  expect(formatLlmReply('hello', '', true)).toBe('hello');
});

test('a reply over 500 characters is truncated with the mention counted in', () => {
  const long = 'x'.repeat(600);
  const out = formatLlmReply(long, 'Bob', true);
  expect(out.length).toBeLessThanOrEqual(500);
  expect(out.startsWith('@Bob ')).toBe(true);
  expect(out.endsWith('...')).toBe(true);
});

test('an over-long reply is truncated even without a mention', () => {
  expect(formatLlmReply('x'.repeat(600), '', false).length).toBeLessThanOrEqual(500);
});

test('whitespace is collapsed so a multi-line reply is a legal chat message', () => {
  expect(formatLlmReply('one\n\ntwo', '', false)).toBe('one two');
});
