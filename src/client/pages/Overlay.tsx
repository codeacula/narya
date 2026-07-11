import React from 'react';
import { AlertStage, useAlertQueue } from '../alerts';
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
  const { current, onFinished } = useMediaQueue();
  return (
    <main className="overlayWidget overlayClipsWidget" aria-label="Redeem clip overlay">
      <ClipStage item={current} onFinished={onFinished} />
    </main>
  );
}

export function OverlayAlertsPage() {
  const { current, onFinished } = useAlertQueue();
  return (
    <main className="overlayWidget overlayAlertsWidget" aria-label="Stream alerts overlay">
      <AlertStage item={current} onFinished={onFinished} />
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
