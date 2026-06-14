import React from 'react';
import { ChatPanel, MusicPanel, useSoundEvents, quackSoundSources } from '../legacy';

export function OverlayPage() {
  const audioRefs = React.useRef<Record<string, HTMLAudioElement | null>>({});
  useSoundEvents(audioRefs);

  return (
    <main className="overlayFrame">
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
      <div className="overlayChat">
        <ChatPanel compact />
      </div>
      <div className="overlayGoals">
        <MusicPanel />
      </div>
    </main>
  );
}
