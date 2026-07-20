import type { LlmResponsePayload, TemplateContext } from '../shared/api';
import type { LlmChatLine, LlmInteractionTurn } from './llmContext';

export type LlmReply = { respond: boolean; message: string };

/** Twitch's per-message ceiling. */
const MAX_CHAT_LENGTH = 500;

const DECLINE_CONTRACT = [
  'Reply with a single JSON object and nothing else:',
  '{"respond": true, "message": "..."} to answer, or {"respond": false} to stay silent.',
  'Do not wrap it in code fences.',
].join(' ');

/**
 * Used when override is selected but the step supplies no prompt of its own — some
 * servers reject an empty instructions field outright.
 */
const FALLBACK_INSTRUCTIONS = 'You answer Twitch chat. Keep it to one short message.';

function joinSections(sections: string[]): string {
  return sections.filter(section => section.trim()).join('\n\n');
}

function actorBlock(context: TemplateContext): string {
  const display = context.actor ?? context.login ?? '';
  if (!display && !context.login) return '';
  const parts = [display];
  if (context.login) parts.push(`(@${context.login})`);
  const facts: string[] = [];
  if (context.role) facts.push(`roles: ${context.role}`);
  if (context.tags && context.tags.length > 0) facts.push(`tags: ${context.tags.join(', ')}`);
  return `Speaker: ${parts.join(' ')}${facts.length ? ` — ${facts.join(' — ')}` : ''}`;
}

function examplesBlock(payload: LlmResponsePayload): string {
  if (payload.examples.length === 0) return '';
  const pairs = payload.examples
    .map(pair => `Input: ${pair.input}\nOutput: ${pair.output}`)
    .join('\n\n');
  return `Answer in the style of these examples:\n\n${pairs}`;
}

function chatBlock(lines: LlmChatLine[]): string {
  if (lines.length === 0) return '';
  const body = lines.map(line => `${line.display}: ${line.message}`).join('\n');
  return `Recent chat, oldest first:\n${body}`;
}

function interactionBlock(turns: LlmInteractionTurn[]): string {
  if (turns.length === 0) return '';
  const body = turns.map(turn => `Them: ${turn.prompt}\nYou: ${turn.reply}`).join('\n');
  return `Earlier in your conversation with this person, oldest first:\n${body}`;
}

/**
 * `instructions` carries the durable contract (persona, examples, decline rules);
 * `input` carries the situational material in a fixed order, so a cached prefix stays
 * stable across invocations.
 *
 * The `!ponder` framing this replaced ("A Twitch chatter named X asks: …") is gone
 * deliberately. The actor block states the speaker's role, which is what lets an
 * operator's system prompt answer a moderator differently without any role branching
 * in code.
 */
export function buildLlmRequest(input: {
  personalityPrompt: string;
  payload: LlmResponsePayload;
  context: TemplateContext;
  prompt: string;
  chatLines: LlmChatLine[];
  interactions: LlmInteractionTurn[];
}): { instructions: string; input: string } {
  const { personalityPrompt, payload, context, prompt, chatLines, interactions } = input;

  const persona = payload.systemPromptMode === 'override'
    ? payload.systemPrompt
    : joinSections([personalityPrompt, payload.systemPrompt]);

  const instructions = joinSections([
    persona.trim() ? persona : FALLBACK_INSTRUCTIONS,
    examplesBlock(payload),
    payload.allowDecline ? DECLINE_CONTRACT : '',
  ]);

  return {
    instructions,
    input: joinSections([
      actorBlock(context),
      chatBlock(chatLines),
      interactionBlock(interactions),
      prompt,
    ]),
  };
}

/** Finds the first balanced `{…}` span, ignoring braces inside JSON strings. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * A model that cannot emit clean JSON still gets its answer through: unparseable
 * output falls through to the raw text. Swallowing it would turn a formatting quirk
 * into a command that mysteriously stops working mid-stream. The gate that carries
 * the safety weight is the tag deny-list, which never depends on model compliance.
 */
export function parseLlmReply(raw: string, allowDecline: boolean): LlmReply {
  if (!allowDecline) return { respond: true, message: raw };

  const candidate = firstJsonObject(raw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, ''));
  if (!candidate) return { respond: true, message: raw };

  try {
    const parsed = JSON.parse(candidate) as { respond?: unknown; message?: unknown };
    if (parsed.respond === false) return { respond: false, message: '' };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return { respond: true, message: parsed.message };
    }
  } catch { /* fall through to the raw text */ }

  return { respond: true, message: raw };
}

/**
 * Collapses whitespace, optionally prefixes the mention, and truncates to Twitch's
 * 500-character ceiling. The mention counts toward the limit — a reply that overflows
 * because of the prefix is still an illegal chat message.
 */
export function formatLlmReply(text: string, mentionName: string, mention: boolean): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const prefix = mention && mentionName ? `@${mentionName} ` : '';
  const full = `${prefix}${compact}`;
  if (full.length <= MAX_CHAT_LENGTH) return full;
  return `${full.slice(0, MAX_CHAT_LENGTH - 3).trimEnd()}...`;
}
