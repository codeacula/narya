import { getRole, renderContent, useChat, useEmotes } from './chat';
import { Countdown } from './countdown';
import { CrystalOrb, type CrystalOrbVariant } from './crystalOrb';
import { endsAtFor, useHoldingScenes } from './holdingScenes';
import { BottomBar, TopBar } from './overlayBars';
import type { HoldingScene as HoldingSceneKey } from '../shared/api';

const CHAT_ROWS = 4;

type SceneCopy = {
  orb: CrystalOrbVariant;
  eyebrow: string;
  headline: string;
  line: string;
  /** Which countdown the scene shows; Ending has none. */
  countdown: HoldingSceneKey | null;
  /** The bottom row's operator line: stream status as "today", or the next-stream text. */
  operatorLine: 'today' | 'next-stream';
};

// Fixed copy, taken from the design mockups: only the countdown and the operator line
// are operator-controlled.
const SCENES = {
  starting: {
    orb: 'arcane',
    eyebrow: 'stream starting',
    headline: 'Starting soon',
    line: 'The greatest orbs to ponder are the stars above.',
    countdown: 'starting',
    operatorLine: 'today',
  },
  brb: {
    orb: 'moon',
    eyebrow: 'intermission',
    headline: 'Be right back',
    line: 'Stepped away from the keyboard. The stars will keep.',
    countdown: 'brb',
    operatorLine: 'today',
  },
  ending: {
    orb: 'moon',
    eyebrow: 'end of stream',
    headline: 'Until next time',
    line: 'Teach, build, and share.',
    countdown: null,
    operatorLine: 'next-stream',
  },
} as const satisfies Record<string, SceneCopy>;

export type HoldingSceneName = keyof typeof SCENES;

/**
 * The last four visible chat messages, persistent. Unlike the compact overlay chat they
 * never expire on a timer: a holding scene is on screen for minutes at a time, and an
 * empty column is the wrong thing to show a room that is waiting. Moderated rows are
 * dropped rather than shown with a reason, the same as every other overlay.
 */
function HoldingChat() {
  const messages = useChat(0);
  const emoteMap = useEmotes();
  const visible = messages.filter(message => !message.deletedAt).slice(-CHAT_ROWS);
  if (visible.length === 0) return null;

  return (
    <section className="holding-chat" aria-label="Chat">
      <span className="holding-chat-eyebrow">chat</span>
      {visible.map(message => (
        <article className="holding-chat-row" data-role={getRole(message.badges)} key={message.id}>
          <strong>{message.displayName}</strong>
          {renderContent(message.message, message.emotes, emoteMap)}
        </article>
      ))}
    </section>
  );
}

/**
 * One layout for Starting soon, Be right back and Ending. Opaque and full-screen,
 * unlike every other overlay: it is a whole OBS scene, not a layer over one.
 *
 * Countdowns never stop or hide on their own. Past zero they read "-02:15" (see
 * formatCountdown), which tells viewers the stream meant to be back by now.
 */
export function HoldingScene({ scene }: { scene: HoldingSceneName }) {
  const copy: SceneCopy = SCENES[scene];
  const [state] = useHoldingScenes();
  const countdownEnd = copy.countdown ? endsAtFor(state, copy.countdown) : null;

  return (
    <main className="holding-scene" aria-label={`${copy.headline} scene`}>
      <div className="holding-stars" aria-hidden="true">
        <div className="holding-stars-layer holding-stars-far" />
        <div className="holding-stars-layer holding-stars-near" />
      </div>
      <TopBar variant="rule" />
      <div className="holding-center">
        <div className="holding-orb">
          <CrystalOrb variant={copy.orb} size={240} />
          <div className="holding-orbit" aria-hidden="true" />
        </div>
        <div className="holding-eyebrow">{copy.eyebrow}</div>
        <div className="holding-headline">{copy.headline}</div>
        <div className="holding-line">{copy.line}</div>
        {copy.countdown ? (
          // Always rendered so the block below it does not jump when a countdown is
          // set or cleared while the scene is on screen.
          <div className="holding-countdown">
            <Countdown endsAt={countdownEnd} />
          </div>
        ) : null}
      </div>
      <HoldingChat />
      <BottomBar
        variant="rule"
        uptimeTone="silver"
        operator={copy.operatorLine === 'next-stream'
          ? { eyebrow: 'next stream', text: state.nextStream }
          : { eyebrow: 'today' }}
      />
    </main>
  );
}
