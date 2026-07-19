import type {
  Action,
  ActionRunResult,
  ActionRunStatus,
  ActionStep,
  ActionStepResult,
  ChatMessage,
  ChatSender,
  MediaAsset,
  OverlayTextPlayback,
  RewardMedia,
  TemplateContext,
} from '../shared/api';
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from '../shared/api';
import { getActionById } from './actions';
import { renderActionTemplate } from './actionTemplates';
import { askPonderLlm } from './llm';
import { switchObsScene, triggerObsTransition } from './obs';
import { broadcast } from './realtime';
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
  askLlm?: (context: TemplateContext, prompt: string) => Promise<string>;
  switchObsScene?: (sceneName: string) => Promise<unknown>;
  triggerObsTransition?: () => Promise<unknown>;
  sendShoutout?: (state: RuntimeState, login: string) => Promise<unknown>;
  sendWhisper?: (state: RuntimeState, login: string, message: string) => Promise<unknown>;
  timeoutUser?: (state: RuntimeState, login: string, seconds: number, reason: string) => Promise<unknown>;
  banUser?: (state: RuntimeState, login: string, reason: string) => Promise<unknown>;
  delay?: (ms: number) => Promise<void>;
  randomIndex?: (length: number) => number;
  newId?: () => string;
  now?: () => Date;
  /** The master media mute. When true, a quickDisable Action is skipped silently. */
  isMuted?: () => boolean;
  /** Seam for tests: applies (or removes) the wind-down title suffix. */
  applyWindDownTitle?: (port: WindDownTitlePort, active: boolean) => Promise<void>;
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

/** askPonderLlm speaks ChatMessage; an Action only has a TemplateContext. */
function chatMessageForLlm(context: TemplateContext): ChatMessage {
  return {
    id: '',
    channel: '',
    username: context.login ?? '',
    displayName: context.actor ?? context.login ?? '',
    color: null,
    message: context.message ?? '',
    receivedAt: new Date().toISOString(),
    deletedAt: null,
    deletedReason: null,
    badges: null,
    emotes: null,
    isFirstTimer: false,
    isFirstThisSession: false,
    isFirstEver: false,
  };
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
    askLlm = (context: TemplateContext, prompt: string) => askPonderLlm(chatMessageForLlm(context), prompt),
    switchObsScene: switchScene = switchObsScene,
    triggerObsTransition: transition = triggerObsTransition,
    sendShoutout = sendTwitchShoutout,
    sendWhisper = sendTwitchWhisper,
    timeoutUser = (runtime: RuntimeState, login: string, seconds: number, reason: string) =>
      moderateTwitchUser(runtime, login, 'timeout', { durationSeconds: seconds, reason }),
    banUser = (runtime: RuntimeState, login: string, reason: string) =>
      moderateTwitchUser(runtime, login, 'ban', { reason }),
    delay = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }),
    randomIndex = (length: number) => Math.floor(Math.random() * length),
    newId = () => crypto.randomUUID(),
    now = () => new Date(),
    isMuted = () => false,
    applyWindDownTitle = applyWindDownTitleImpl,
  } = deps;

  /**
   * A timeout duration bound from the invocation (`{arg2}` in `/timeout bob 300 spam`)
   * may render empty, non-numeric, or out of range — chat and the command bar are both
   * free-form. Fall back to the default rather than failing the step: a moderation
   * command that lands with the wrong duration beats one that does not land at all.
   */
  function renderTimeoutSeconds(template: string, context: TemplateContext): number {
    const rendered = renderActionTemplate(template, context).trim();
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

  async function dispatch(step: ActionStep, context: TemplateContext): Promise<StepOutcome> {
    const render = (template: string) => renderActionTemplate(template, context);

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
        const answer = await askLlm(context, prompt);
        if (!answer.trim()) return skipped('The LLM returned no text.');
        await sendChat(state, answer, 'bot');
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
