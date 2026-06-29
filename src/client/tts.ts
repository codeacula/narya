import React from 'react';
import type { TtsPlayback } from '../shared/api';
import { useSocket } from './realtime';

export function useTtsEvents() {
  useSocket<TtsPlayback>(
    'tts:speak',
    React.useCallback((payload) => {
      try {
        const bytes = Uint8Array.from(atob(payload.audioBase64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: payload.mimeType || 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = Math.max(0, Math.min(1, payload.volume ?? 0.8));
        audio.addEventListener('ended', () => URL.revokeObjectURL(url));
        audio.addEventListener('error', () => URL.revokeObjectURL(url));
        void audio.play().catch((err: unknown) => {
          console.error('TTS: failed to play audio:', err);
          URL.revokeObjectURL(url);
        });
      } catch (err) {
        console.error('TTS: failed to decode audio:', err);
      }
    }, []),
  );
}
