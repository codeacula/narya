import { expect, test } from 'bun:test';
import type { Action, LlmResponsePayload, TemplateContext } from '../shared/api';
import type { ActionExecutorDeps } from './actionExecutor';
import { createActionExecutor } from './actionExecutor';

const payload = (overrides: Partial<LlmResponsePayload> = {}): LlmResponsePayload => ({
  template: 'Answer {actor}',
  systemPrompt: '',
  systemPromptMode: 'enhance',
  chatHistoryLines: 0,
  interactionHistory: 0,
  examples: [],
  allowTags: [],
  denyTags: [],
  allowDecline: false,
  mention: true,
  ...overrides,
});

function actionWith(llmPayload: LlmResponsePayload): Action {
  return {
    id: 'action-1',
    name: 'Lurk',
    description: '',
    enabled: true,
    quickDisable: false,
    steps: [{ id: 'step-1', position: 0, enabled: true, delayMs: 0, type: 'llm_response', payload: llmPayload }],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

type Harness = {
  sent: string[];
  recorded: Array<{ login: string; prompt: string; reply: string }>;
  requests: Array<{ instructions: string; input: string }>;
};

async function run(
  llmPayload: LlmResponsePayload,
  context: TemplateContext,
  overrides: Partial<ActionExecutorDeps> = {},
) {
  const state: Harness = { sent: [], recorded: [], requests: [] };
  const action = actionWith(llmPayload);
  const deps: ActionExecutorDeps = {
    resolveMedia: () => null,
    state: {} as never,
    loadAction: () => action,
    personalityPrompt: () => 'You are Narya.',
    resolveViewerTags: () => [],
    recentChatLines: () => [],
    loadInteractions: () => [],
    recordInteraction: (login, prompt, reply) => { state.recorded.push({ login, prompt, reply }); },
    askLlm: async (instructions, input) => {
      state.requests.push({ instructions, input });
      return 'the answer';
    },
    sendChat: async (_runtime, message) => { state.sent.push(message); return undefined; },
    ...overrides,
  };
  const result = await createActionExecutor(deps).runAction('action-1', context);
  return { state, result };
}

test('a plain step sends the answer with an @mention', async () => {
  const { state, result } = await run(payload(), { actor: 'Bob', login: 'bob' });
  expect(result.status).toBe('succeeded');
  expect(state.sent).toEqual(['@Bob the answer']);
});

test('mention off sends the answer bare', async () => {
  const { state } = await run(payload({ mention: false }), { actor: 'Bob', login: 'bob' });
  expect(state.sent).toEqual(['the answer']);
});

test('a denied tag skips the step and never calls the model', async () => {
  const { state, result } = await run(
    payload({ denyTags: ['no-llm'] }),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['no-llm'] },
  );
  expect(result.status).toBe('skipped');
  expect(state.requests).toEqual([]);
  expect(state.sent).toEqual([]);
});

test('the deny gate matches regardless of the case the tag was saved in', async () => {
  const { result } = await run(
    payload({ denyTags: ['no-llm'] }),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['No-LLM'] },
  );
  expect(result.status).toBe('skipped');
});

test('an allow list admits a viewer holding the tag', async () => {
  const { result } = await run(
    payload({ allowTags: ['vip'] }),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['vip'] },
  );
  expect(result.status).toBe('succeeded');
});

test('an allow list rejects an invocation with no login', async () => {
  const { result } = await run(payload({ allowTags: ['vip'] }), {});
  expect(result.status).toBe('skipped');
});

test('a decline sends nothing and records nothing', async () => {
  const { state, result } = await run(
    payload({ allowDecline: true }),
    { actor: 'Bob', login: 'bob' },
    { askLlm: async () => '{"respond": false}' },
  );
  expect(result.status).toBe('skipped');
  expect(state.sent).toEqual([]);
  expect(state.recorded).toEqual([]);
});

test('a successful reply is recorded to interaction memory', async () => {
  const { state } = await run(payload(), { actor: 'Bob', login: 'bob' });
  expect(state.recorded).toEqual([{ login: 'bob', prompt: 'Answer Bob', reply: 'the answer' }]);
});

test('a failed chat send records nothing', async () => {
  // A chat outage must not record an exchange the viewer never saw.
  const { state, result } = await run(
    payload(),
    { actor: 'Bob', login: 'bob' },
    { sendChat: async () => { throw new Error('chat is down'); } },
  );
  expect(result.status).toBe('failed');
  expect(state.recorded).toEqual([]);
});

test('an invocation with no login records nothing', async () => {
  const { state } = await run(payload(), { actor: 'System' });
  expect(state.recorded).toEqual([]);
});

test('chat lines are requested only when the step asks for them', async () => {
  let asked = -1;
  await run(payload({ chatHistoryLines: 7 }), { actor: 'Bob', login: 'bob' }, {
    recentChatLines: (limit) => { asked = limit; return []; },
  });
  expect(asked).toBe(7);
});

test('chat lines are not requested when the count is zero', async () => {
  let called = false;
  await run(payload({ chatHistoryLines: 0 }), { actor: 'Bob', login: 'bob' }, {
    recentChatLines: () => { called = true; return []; },
  });
  expect(called).toBe(false);
});

test('interactions are not loaded when the count is zero', async () => {
  let called = false;
  await run(payload({ interactionHistory: 0 }), { actor: 'Bob', login: 'bob' }, {
    loadInteractions: () => { called = true; return []; },
  });
  expect(called).toBe(false);
});

test('an empty prompt template skips before any gate or model call', async () => {
  const { state, result } = await run(payload({ template: '' }), { actor: 'Bob', login: 'bob' });
  expect(result.status).toBe('skipped');
  expect(state.requests).toEqual([]);
});

test('the resolved tags reach the prompt so the model can see them', async () => {
  const { state } = await run(
    payload(),
    { actor: 'Bob', login: 'bob' },
    { resolveViewerTags: () => ['artist'] },
  );
  expect(state.requests[0]!.input).toContain('artist');
});

test('the step system prompt reaches the instructions', async () => {
  const { state } = await run(
    payload({ systemPrompt: 'Be terse.' }),
    { actor: 'Bob', login: 'bob' },
  );
  expect(state.requests[0]!.instructions).toContain('Be terse.');
  expect(state.requests[0]!.instructions).toContain('You are Narya.');
});

test('an over-long model reply is truncated before it reaches chat', async () => {
  const { state } = await run(
    payload({ mention: false }),
    { actor: 'Bob', login: 'bob' },
    { askLlm: async () => 'x'.repeat(900) },
  );
  expect(state.sent[0]!.length).toBeLessThanOrEqual(500);
});
