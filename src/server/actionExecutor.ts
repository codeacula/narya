import type {
  Action,
  ActionRunResult,
  ActionRunStatus,
  ActionStep,
  ActionStepResult,
  ChatMessage,
  ChatSender,
  Counter,
  CounterAdjustMode,
  MediaAsset,
  OverlayTextPlayback,
  Quote,
  QuoteInput,
  RewardMedia,
  TemplateContext,
} from '../shared/api';
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from '../shared/api';
import { getActionById } from './actions';
import type { CounterResolver } from './actionTemplates';
import { renderActionTemplate } from './actionTemplates';
import { adjustCounter as adjustCounterRow, getCounterValue, parseCounterAmount } from './counters';
import { getPersonalityPrompt, runLlmRequest } from './llm';
// NOT './chat': chat.ts imports automation.ts, which imports this file. Adding the
// reverse edge closes a load-time cycle and fails at boot rather than as a clean error.
import {
  loadInteractions as loadInteractionsImpl,
  recentChatLines as recentChatLinesImpl,
  recordInteraction as recordInteractionImpl,
} from './llmContext';
import type { LlmChatLine, LlmInteractionTurn } from './llmContext';
import { buildLlmRequest, formatLlmReply, parseLlmReply } from './llmPrompt';
import { getViewerTags } from './viewerIdentity';
import { tagGateAllows } from '../shared/viewerTags';
import { switchObsScene, triggerObsTransition } from './obs';
import { broadcast } from './realtime';
import { addQuote, recordQuoteShown, resolveQuote } from './quotes';
import { playMedia } from './rewardMedia';
import type { RuntimeState } from './runtime';
import { speakText } from './tts';
import { moderateTwitchUser, sendTwitchChatMessage, sendTwitchShoutout, sendTwitchWhisper } from './twitch/api';
import { setWindDownActive } from './windDown';
import {
  applyWindDownTitle as applyWindDownTitleImpl,
  windDownTitlePort,
  type WindDownTitlePort,
} from './windDownLoop';

/**
 * How a play_media step turns an asset id into something playable. Injected rather
 * than imported: the configured-media catalog owns availability (a local file that
 * has gone missing, a disabled asset), and returning null is how it says "unknown,
 * disabled, or unavailable" — the step then skips and emits nothing.
 */
export type MediaResolver = (assetId: string) => MediaAsset | null;

export type ActionExecutorDeps = {
  resolveMedia: MediaResolver;
  state: RuntimeState;
  /** Everything below is a seam for tests; each defaults to the real service. */
  loadAction?: (actionId: string) => Action | null;
  broadcast?: (event: string, payload: unknown) => void;
  playMedia?: (media: RewardMedia, actor?: string) => void;
  speakText?: (text: string) => Promise<void>;
  sendChat?: (state: RuntimeState, message: string, sender: ChatSender) => Promise<unknown>;
  /** Runs an assembled request. Prompt construction lives in llmPrompt.ts. */
  askLlm?: (instructions: string, input: string) => Promise<string>;
  /** The global personality prompt an llm_response step enhances or overrides. */
  personalityPrompt?: () => string;
  /** The operator's own tags for a viewer, for the llm_response targeting gate. */
  resolveViewerTags?: (login: string) => string[];
  /** Recent channel chat for an llm_response step's context. */
  recentChatLines?: (limit: number) => LlmChatLine[];
  /** Prior exchanges between this viewer and the bot. */
  loadInteractions?: (login: string, limit: number) => LlmInteractionTurn[];
  /** Records an exchange AFTER it has reached chat. */
  recordInteraction?: (login: string, prompt: string, reply: string) => void;
  switchObsScene?: (sceneName: string) => Promise<unknown>;
  triggerObsTransition?: () => Promise<unknown>;
  sendShoutout?: (state: RuntimeState, login: string) => Promise<unknown>;
  sendWhisper?: (state: RuntimeState, login: string, message: string) => Promise<unknown>;
  timeoutUser?: (state: RuntimeState, login: string, seconds: number, reason: string) => Promise<unknown>;
  banUser?: (state: RuntimeState, login: string, reason: string) => Promise<unknown>;
  addQuote?: (input: QuoteInput) => Quote;
  resolveQuote?: (query: string, randomIndex: (length: number) => number) => Quote | null;
  recordQuoteShown?: (id: string) => void;
  delay?: (ms: number) => Promise<void>;
  randomIndex?: (length: number) => number;
  newId?: () => string;
  now?: () => Date;
  /** The master media mute. When true, a quickDisable Action is skipped silently. */
  isMuted?: () => boolean;
  /** Seam for tests: applies (or removes) the wind-down title suffix. */
  applyWindDownTitle?: (port: WindDownTitlePort, active: boolean) => Promise<void>;
  /**
   * Applies an adjust_counter step. Returns null when the counter is gone, which
   * the step reports as a skip.
   */
  adjustCounter?: (id: string, mode: CounterAdjustMode, amount: number) => Counter | null;
  /** Live per-render lookup for {counter:key}. See CounterResolver. */
  resolveCounter?: CounterResolver;
};

export type ActionExecutor = {
  runAction(actionId: string, context: TemplateContext): Promise<ActionRunResult>;
};

type StepOutcome = { status: ActionStepResult['status']; detail: string };

const SUCCEEDED: StepOutcome = { status: 'succeeded', detail: '' };
const skipped = (detail: string): StepOutcome => ({ status: 'skipped', detail });

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return String(error);
}

/** Logins arrive from templates, so "@Sorlus" and "Sorlus" must both work. */
function normalizeLogin(value: string): string {
  return value.trim().replace(/^@+/, '').trim().toLowerCase();
}

export function createActionExecutor(deps: ActionExecutorDeps): ActionExecutor {
  const {
    resolveMedia,
    state,
    loadAction = getActionById,
    broadcast: emit = broadcast,
    playMedia: play = playMedia,
    speakText: speak = speakText,
    sendChat = (runtime: RuntimeState, message: string, sender: ChatSender) =>
      sendTwitchChatMessage(runtime, message, sender),
    askLlm = runLlmRequest,
    personalityPrompt = getPersonalityPrompt,
    resolveViewerTags = getViewerTags,
    recentChatLines = recentChatLinesImpl,
    loadInteractions = loadInteractionsImpl,
    recordInteraction = recordInteractionImpl,
    switchObsScene: switchScene = switchObsScene,
    triggerObsTransition: transition = triggerObsTransition,
    sendShoutout = sendTwitchShoutout,
    sendWhisper = sendTwitchWhisper,
    timeoutUser = (runtime: RuntimeState, login: string, seconds: number, reason: string) =>
      moderateTwitchUser(runtime, login, 'timeout', { durationSeconds: seconds, reason }),
    banUser = (runtime: RuntimeState, login: string, reason: string) =>
      moderateTwitchUser(runtime, login, 'ban', { reason }),
    addQuote: saveQuote = addQuote,
    resolveQuote: findQuote = resolveQuote,
    recordQuoteShown: markQuoteShown = recordQuoteShown,
    delay = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }),
    randomIndex = (length: number) => Math.floor(Math.random() * length),
    newId = () => crypto.randomUUID(),
    now = () => new Date(),
    isMuted = () => false,
    applyWindDownTitle = applyWindDownTitleImpl,
    adjustCounter = adjustCounterRow,
    resolveCounter = getCounterValue,
  } = deps;

  /**
   * A timeout duration bound from the invocation (`{arg2}` in `/timeout bob 300 spam`)
   * may render empty, non-numeric, or out of range — chat and the command bar are both
   * free-form. Fall back to the default rather than failing the step: a moderation
   * command that lands with the wrong duration beats one that does not land at all.
   */
  function renderTimeoutSeconds(template: string, context: TemplateContext): number {
    const rendered = renderActionTemplate(template, context, resolveCounter).trim();
    const seconds = Math.round(Number(rendered));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
      return DEFAULT_TIMEOUT_SECONDS;
    }
    return seconds;
  }

  function pickAsset(assetIds: string[], selection: 'first' | 'random'): MediaAsset | null {
    const available = assetIds
      .map(id => resolveMedia(id))
      .filter((candidate): candidate is MediaAsset => Boolean(candidate) && candidate!.enabled && candidate!.available);
    if (available.length === 0) return null;
    if (selection === 'first') return available[0]!;
    // Clamped: a chooser must never index past the assets that actually resolved.
    const index = Math.min(Math.max(0, Math.floor(randomIndex(available.length))), available.length - 1);
    return available[index]!;
  }

  /**
   * Deliver a quote step's own message to Twitch chat. Quote steps announce their
   * result themselves rather than handing it to a downstream send_chat step, because
   * steps run concurrently and cannot pass values to one another.
   */
  async function announce(message: string): Promise<void> {
    await sendChat(state, message, 'bot');
  }

  /** The invocation context plus the tokens only a quote step can supply. */
  function withQuote(context: TemplateContext, quote: Quote): TemplateContext {
    return {
      ...context,
      quoteNumber: quote.number,
      quoteText: quote.text,
      quoteSlug: quote.slug ?? '',
      quoteSubmitter: quote.submittedBy,
      quoteShownCount: quote.shownCount,
      quoteDate: quote.createdAt.slice(0, 10),
    };
  }

  async function dispatch(step: ActionStep, context: TemplateContext): Promise<StepOutcome> {
    // The funnel for every template render in this switch, so counter tokens work
    // in text, chat, TTS, whispers, and LLM prompts from this one place.
    const render = (template: string) => renderActionTemplate(template, context, resolveCounter);

    switch (step.type) {
      case 'show_text': {
        const text = render(step.payload.template);
        if (!text.trim()) return skipped('The text template rendered empty.');
        // Only the resolved playback goes on the wire — the overlay is a public
        // browser source and must never see the operator's Action configuration.
        const playback: OverlayTextPlayback = {
          id: newId(),
          text,
          durationMs: step.payload.durationMs,
          style: step.payload.style,
          ...(step.payload.tone ? { tone: step.payload.tone } : {}),
        };
        emit('overlay:text', playback);
        return SUCCEEDED;
      }

      case 'play_media': {
        const asset = pickAsset(step.payload.assetIds, step.payload.selection);
        if (!asset) return skipped('No media asset for this step is available.');
        const volume = step.payload.volume ?? asset.volume;
        play({ kind: asset.kind, src: asset.src, volume }, context.actor);
        return SUCCEEDED;
      }

      case 'tts_speak': {
        const text = render(step.payload.template);
        if (!text.trim()) return skipped('The TTS template rendered empty.');
        await speak(text);
        return SUCCEEDED;
      }

      case 'send_chat': {
        const message = render(step.payload.template);
        if (!message.trim()) return skipped('The chat template rendered empty.');
        await sendChat(state, message, step.payload.sender);
        return SUCCEEDED;
      }

      case 'llm_response': {
        const prompt = render(step.payload.template);
        if (!prompt.trim()) return skipped('The LLM prompt rendered empty.');

        const login = context.login ?? '';
        // Resolved before the request so a denied viewer costs no tokens and no latency.
        const tags = login ? resolveViewerTags(login) : [];
        if (!tagGateAllows(tags, step.payload.allowTags, step.payload.denyTags)) {
          // A tagged viewer running the command is normal traffic, not a fault — the
          // same reasoning quote_show applies to a query that matches nothing.
          return skipped('This viewer is excluded from LLM replies by tag.');
        }

        const request = buildLlmRequest({
          personalityPrompt: personalityPrompt(),
          payload: step.payload,
          context: { ...context, tags },
          prompt,
          chatLines: step.payload.chatHistoryLines > 0 ? recentChatLines(step.payload.chatHistoryLines) : [],
          interactions: login && step.payload.interactionHistory > 0
            ? loadInteractions(login, step.payload.interactionHistory)
            : [],
        });

        const reply = parseLlmReply(await askLlm(request.instructions, request.input), step.payload.allowDecline);
        if (!reply.respond) return skipped('The LLM chose not to respond.');
        if (!reply.message.trim()) return skipped('The LLM returned no text.');

        const message = formatLlmReply(reply.message, context.actor ?? context.login ?? '', step.payload.mention);
        await sendChat(state, message, 'bot');
        // AFTER the send, never before: a chat outage must not record an exchange the
        // viewer never saw.
        if (login) recordInteraction(login, prompt, reply.message);
        return SUCCEEDED;
      }

      case 'obs_scene':
        await switchScene(step.payload.sceneName);
        return SUCCEEDED;

      case 'obs_transition':
        await transition();
        return SUCCEEDED;

      case 'twitch_shoutout': {
        const login = normalizeLogin(render(step.payload.loginTemplate));
        if (!login) return skipped('The shoutout target rendered empty.');
        await sendShoutout(state, login);
        return SUCCEEDED;
      }

      case 'twitch_whisper': {
        const login = normalizeLogin(render(step.payload.loginTemplate));
        if (!login) return skipped('The whisper target rendered empty.');
        const message = render(step.payload.template);
        if (!message.trim()) return skipped('The whisper template rendered empty.');
        await sendWhisper(state, login, message);
        return SUCCEEDED;
      }

      case 'twitch_timeout': {
        const login = normalizeLogin(render(step.payload.loginTemplate));
        if (!login) return skipped('The timeout target rendered empty.');
        await timeoutUser(state, login, renderTimeoutSeconds(step.payload.secondsTemplate, context), render(step.payload.reasonTemplate));
        return SUCCEEDED;
      }

      case 'twitch_ban': {
        const login = normalizeLogin(render(step.payload.loginTemplate));
        if (!login) return skipped('The ban target rendered empty.');
        await banUser(state, login, render(step.payload.reasonTemplate));
        return SUCCEEDED;
      }

      case 'set_wind_down': {
        setWindDownActive({ active: step.payload.active, source: 'action' });
        // The title is best-effort: the overlay signal has already gone out, and a
        // Twitch hiccup should not fail a step whose visible effect already landed.
        try {
          await applyWindDownTitle(windDownTitlePort(state), step.payload.active);
        } catch (error) {
          console.error('Actions: wind-down title update failed:', error);
        }
        return SUCCEEDED;
      }

      case 'adjust_counter': {
        const rendered = render(step.payload.amountTemplate).trim();
        // Deliberately unlike twitch_timeout, which falls back to a default: there
        // is no safe default for how much to write into a durable counter, so a
        // template that renders empty or out of range skips rather than guessing.
        // The range check matters because this amount can come from a VIEWER —
        // "!death {arg1}" puts chat text here, and 1e308 is finite.
        const amount = parseCounterAmount(rendered);
        if (!rendered || amount === null) {
          return skipped(`The counter amount rendered "${rendered}", which is not a whole number.`);
        }
        const counter = adjustCounter(step.payload.counterId, step.payload.mode, amount);
        if (!counter) return skipped('That counter no longer exists.');
        return { status: 'succeeded', detail: `${counter.key} = ${counter.value}` };
      }

      case 'quote_add': {
        const text = render(step.payload.textTemplate);
        if (!text.trim()) return skipped('The quote text rendered empty.');
        const quote = saveQuote({
          text,
          slug: render(step.payload.slugTemplate) || null,
          submittedBy: context.actor ?? context.login ?? 'unknown',
          submittedByLogin: context.login ?? '',
        });
        const reply = renderActionTemplate(step.payload.replyTemplate, withQuote(context, quote), resolveCounter);
        // An empty reply template is a deliberate "add it quietly", not a failure —
        // the quote is already saved either way.
        if (reply.trim()) {
          await announce(reply);
        }
        return SUCCEEDED;
      }

      case 'quote_show': {
        const quote = findQuote(render(step.payload.queryTemplate), randomIndex);
        // A viewer asking for a quote that does not exist is normal traffic, so this
        // skips rather than failing — a failed run reads as "Narya is broken".
        if (!quote) return skipped('No quote matched that number, slug, or keyword.');
        const message = renderActionTemplate(step.payload.messageTemplate, withQuote(context, quote), resolveCounter);
        if (!message.trim()) return skipped('The quote message template rendered empty.');
        await announce(message);
        // Only after delivery: a Discord outage must not inflate the counter for a
        // quote nobody saw.
        markQuoteShown(quote.id);
        return SUCCEEDED;
      }
    }
  }

  /**
   * delayMs is relative to the start of the invocation, not to the previous step:
   * every step waits out its own delay from the same t0 and is then started in
   * stored order WITHOUT awaiting the step before it, so a banner, a video, and a
   * TTS line sharing a delay all land together instead of queueing behind each
   * other's playback. A step that throws is contained here and never aborts the
   * rest. Pending delays live only in this process — a restart drops them rather
   * than replaying time-sensitive steps against a stream that has moved on.
   */
  async function runStep(step: ActionStep, context: TemplateContext): Promise<ActionStepResult> {
    const result = (outcome: StepOutcome): ActionStepResult => ({
      stepId: step.id,
      type: step.type,
      status: outcome.status,
      detail: outcome.detail,
    });

    if (!step.enabled) return result(skipped('Step is disabled.'));

    try {
      if (step.delayMs > 0) await delay(step.delayMs);
      return result(await dispatch(step, context));
    } catch (error) {
      const detail = errorDetail(error);
      console.error(`Actions: step ${step.id} (${step.type}) failed:`, error);
      return result({ status: 'failed', detail });
    }
  }

  function rollUp(steps: ActionStepResult[]): ActionRunStatus {
    const ran = steps.filter(step => step.status !== 'skipped');
    if (ran.length === 0) return 'skipped';
    if (ran.every(step => step.status === 'succeeded')) return 'succeeded';
    if (ran.every(step => step.status === 'failed')) return 'failed';
    return 'partial';
  }

  async function runAction(actionId: string, context: TemplateContext): Promise<ActionRunResult> {
    const ranAt = now().toISOString();
    const action = loadAction(actionId);

    // A missing or disabled Action broadcasts nothing at all.
    if (!action || !action.enabled) {
      return { actionId, status: 'skipped', steps: [], ranAt };
    }

    // Master media mute: an opted-in Action is skipped silently while muted. This is
    // the single choke point, so every source — command, reward, manual, module —
    // honors it uniformly, and a skipped run broadcasts nothing (no media:play, no
    // overlay:text), so overlays stay quiet with no new play path.
    if (action.quickDisable && isMuted()) {
      return { actionId, status: 'skipped', steps: [], ranAt };
    }

    const steps = await Promise.all(action.steps.map(step => runStep(step, context)));
    return { actionId, status: rollUp(steps), steps, ranAt };
  }

  return { runAction };
}
