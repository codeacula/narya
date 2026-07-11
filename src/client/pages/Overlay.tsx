import React from 'react';
import { ChatPanel } from '../chat';
import { ClipStage, useMediaQueue } from '../clips';
import { MusicPanel } from '../music';
import { OverlayTextStage, useOverlayTextQueue } from '../overlayText';
import { ShoutoutTicker, useSessionShoutouts } from '../shoutouts';
import { quackSoundSources, useSoundEvents } from '../sounds';
import { useStreamStatus } from '../streamStatus';
import { useTtsEvents } from '../tts';

export function OverlaySoundsPage() {
  const audioRefs = React.useRef<Record<string, HTMLAudioElement | null>>({});
  useSoundEvents(audioRefs);
  useTtsEvents();
  return (
    <main className="soundBank" aria-label="Sound playback overlay">
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
    <main className="overlayWidget overlayChatWidget">
      <ChatPanel compact />
    </main>
  );
}

export function OverlayNowPlayingPage() {
  return (
    <main className="overlayWidget overlayNowPlayingWidget">
      <MusicPanel />
    </main>
  );
}

export function OverlayClipsPage() {
  const { current, currentAudio, onFinished } = useMediaQueue();
  return (
    <main className="overlayWidget overlayClipsWidget" aria-label="Redeem clip overlay">
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
    <main className="overlayWidget overlayStatusWidget" aria-label="Stream status overlay">
      {text ? <div className="overlayStatusText">{text}</div> : null}
    </main>
  );
}

export function OverlayTextPage() {
  const { current, onFinished } = useOverlayTextQueue();
  return (
    <main className="overlayWidget overlayTextWidget" aria-label="Action text overlay">
      <OverlayTextStage item={current} onFinished={onFinished} />
    </main>
  );
}

export function OverlayShoutoutsPage() {
  const shoutouts = useSessionShoutouts();
  return (
    <main className="overlayWidget overlayShoutoutsWidget" aria-label="Stream shoutouts overlay">
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
    <main className="overlayWidget overlayUnknownWidget" aria-label="Unknown overlay">
      <div className="overlayUnknownNotice">
        <strong>Narya: no overlay at {path}</strong>
        <span>Point this browser source at /overlay/chat, /nowplaying, /sounds, /clips, /text, /shoutouts, or /status.</span>
      </div>
    </main>
  );
}

export function OverlayPage() {
  return (
    <main className="overlayFrame">
      <div className="overlayChat">
        <ChatPanel compact />
      </div>
      <div className="overlayGoals">
        <MusicPanel />
      </div>
    </main>
  );
}
