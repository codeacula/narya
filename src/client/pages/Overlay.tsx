import React from 'react';
import { ChatPanel } from '../chat';
import { MusicPanel } from '../music';
import { quackSoundSources, useSoundEvents } from '../sounds';
import { useTtsEvents } from '../tts';

function SoundBank() {
  const audioRefs = React.useRef<Record<string, HTMLAudioElement | null>>({});
  useSoundEvents(audioRefs);
  return (
    <div className="soundBank" aria-hidden="true">
      {quackSoundSources.map(src => (
        <audio
          key={src}
          preload="auto"
          ref={audio => { audioRefs.current[src] = audio; }}
          src={src}
        />
      ))}
    </div>
  );
}

export function OverlayChatPage() {
  return (
    <main className="overlayWidget overlayChatWidget">
      <SoundBank />
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

export function OverlayPage() {
  useTtsEvents();
  return (
    <main className="overlayFrame">
      <SoundBank />
      <div className="overlayChat">
        <ChatPanel compact />
      </div>
      <div className="overlayGoals">
        <MusicPanel />
      </div>
    </main>
  );
}
