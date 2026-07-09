import React from 'react';
import { ChatPanel } from '../chat';
import { MusicPanel } from '../music';
import { ShoutoutTicker, useSessionShoutouts } from '../shoutouts';
import { quackSoundSources, useSoundEvents } from '../sounds';
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
