import React from 'react';
import { ChatPanel } from '../chat';
import { ClipStage, useMediaQueue } from '../clips';
import { MusicPanel } from '../music';
import { OverlayTextStage, useOverlayTextQueue } from '../overlayText';
import { ShoutoutTicker, useSessionShoutouts } from '../shoutouts';
import { quackSoundSources, useSoundEvents } from '../sounds';
import { useStreamStatus } from '../streamStatus';
import { useTtsEvents } from '../tts';
import { useWindDownOverlay } from '../windDown';
import { formatWindDownCountdown } from '../windDownCountdown';

export function OverlaySoundsPage() {
  const audioRefs = React.useRef<Record<string, HTMLAudioElement | null>>({});
  useSoundEvents(audioRefs);
  useTtsEvents();
  return (
    <main className="sound-bank" aria-label="Sound playback overlay">
      {quackSoundSources.map(src => (
        <audio
          key={src}
          preload="auto"
          ref={audio => { audioRefs.current[src] = audio; }}
          src={src}
        />
      ))}
    </main>
  );
}

export function OverlayChatPage() {
  return (
    <main className="overlay-widget overlay-chat-widget">
      <ChatPanel compact />
    </main>
  );
}

export function OverlayNowPlayingPage() {
  return (
    <main className="overlay-widget overlay-now-playing-widget">
      <MusicPanel />
    </main>
  );
}

export function OverlayClipsPage() {
  const { current, currentAudio, onFinished } = useMediaQueue();
  return (
    <main className="overlay-widget overlay-clips-widget" aria-label="Redeem clip overlay">
      {/* Two lanes: only video is visually exclusive, so a sound never waits out a
          clip. See useMediaQueue. */}
      <ClipStage item={current} onFinished={onFinished} />
      <ClipStage item={currentAudio} onFinished={onFinished} />
    </main>
  );
}

export function OverlayStatusPage() {
  const status = useStreamStatus();
  const text = status?.text ?? '';
  return (
    <main className="overlay-widget overlay-status-widget" aria-label="Stream status overlay">
      {text ? <div className="overlay-status-text">{text}</div> : null}
    </main>
  );
}

/**
 * The wind-down signal: a prospective raider deciding whether to send their viewers
 * here can see the stream is wrapping up. Twitch offers no way to block an incoming
 * raid, so telling them is the whole mechanism.
 *
 * The countdown ticks client-side from `plannedEndAt` rather than from server
 * messages, so it stays smooth without a broadcast every second.
 */
export function OverlayWindDownPage() {
  const state = useWindDownOverlay();
  const [now, setNow] = React.useState(() => Date.now());

  const active = Boolean(state?.active && state.overlayEnabled);

  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return <main className="overlay-widget overlay-winddown-widget" aria-label="Wind-down overlay" />;

  const endMs = state?.plannedEndAt ? new Date(state.plannedEndAt).getTime() : Number.NaN;
  const countdown = Number.isFinite(endMs) ? formatWindDownCountdown(endMs - now) : null;

  return (
    <main className="overlay-widget overlay-winddown-widget" aria-label="Wind-down overlay">
      <div className="overlay-winddown-card">
        <span className="overlay-winddown-label">Wrapping up</span>
        {countdown ? <span className="overlay-winddown-countdown">{countdown}</span> : null}
      </div>
    </main>
  );
}

export function OverlayTextPage() {
  const { current, onFinished } = useOverlayTextQueue();
  return (
    <main className="overlay-widget overlay-text-widget" aria-label="Action text overlay">
      <OverlayTextStage item={current} onFinished={onFinished} />
    </main>
  );
}

export function OverlayShoutoutsPage() {
  const shoutouts = useSessionShoutouts();
  return (
    <main className="overlay-widget overlay-shoutouts-widget" aria-label="Stream shoutouts overlay">
      <ShoutoutTicker shoutouts={shoutouts} />
    </main>
  );
}

/**
 * An OBS browser source pointing at an overlay path that does not exist.
 *
 * It says so rather than rendering blank: a silent transparent page looks exactly like
 * a working overlay that has nothing to show yet, so a typo'd or retired URL would sit
 * dead in a scene collection indefinitely. The same reasoning as a media asset that
 * lands disabled — visibly broken and repairable beats quietly doing nothing.
 *
 * What it must never do is fall through to the dashboard, which is the bug this
 * replaces: chat, controls, and viewer data rendered into a live scene.
 */
export function OverlayUnknownPage({ path }: { path: string }) {
  return (
    <main className="overlay-widget overlay-unknown-widget" aria-label="Unknown overlay">
      <div className="overlay-unknown-notice">
        <strong>Narya: no overlay at {path}</strong>
        <span>Point this browser source at /overlay/chat, /nowplaying, /sounds, /clips, /text, /shoutouts, or /status.</span>
      </div>
    </main>
  );
}

export function OverlayPage() {
  return (
    <main className="overlay-frame">
      <div className="overlay-chat">
        <ChatPanel compact />
      </div>
      <div className="overlay-goals">
        <MusicPanel />
      </div>
    </main>
  );
}
