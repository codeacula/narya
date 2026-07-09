import React from 'react';
import type { SoundButton, SoundPlayback } from '../shared/api';
import { getSoundButtons } from './services/dashboard';
import { useSocket } from './realtime';

export const quackSoundSources = [
  '/sounds/quacks/075176_duck-quack-40345.mp3',
  '/sounds/quacks/duck-quack-112941.mp3',
  '/sounds/quacks/duck-quacking-37392.mp3',
];

/** Synthesized cue tone. Dashboard uses these for mentions, whispers, and the attention feed. */
export function playTone(freq: number, durationMs: number, volume: number) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
  osc.onended = () => void ctx.close();
}

/** Rising three-note chime, distinct from the two-note mention and whisper cues. */
export function playAttentionChime() {
  playTone(784, 90, 0.22);
  setTimeout(() => playTone(988, 90, 0.2), 95);
  setTimeout(() => playTone(1319, 160, 0.18), 195);
}

export function useSoundButtons() {
  const [soundButtons, setSoundButtons] = React.useState<SoundButton[]>([]);

  React.useEffect(() => {
    getSoundButtons()
      .then(setSoundButtons)
      .catch((error: unknown) => {
        console.error('Failed to load sound buttons:', error);
      });
  }, []);

  return soundButtons;
}

export function useSoundEvents(audioRefs: React.RefObject<Record<string, HTMLAudioElement | null>>) {
  useSocket<SoundPlayback>(
    'sound:play',
    React.useCallback((sound) => {
      const audio = audioRefs.current[sound.src] ?? new Audio(sound.src);
      audio.volume = Math.max(0, Math.min(1, sound.volume ?? 1));
      audio.currentTime = 0;
      void audio.play().catch((err: unknown) => { console.error('Failed to play sound:', err); });
    }, [audioRefs]),
  );
}
