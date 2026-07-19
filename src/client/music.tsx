import React from 'react';
import type { MusicInfo } from '../shared/api';
import { useLiveValue } from './liveValue';
import { getCurrentMusic } from './services/dashboard';

export function useMusic() {
  const [music] = useLiveValue<MusicInfo | null>(getCurrentMusic, 'music:updated', null);

  return music;
}

export function MusicPanel() {
  const music = useMusic();
  const hasTrack = (music?.status === 'playing' || music?.status === 'paused') && music.title;

  return (
    <div className="music-now">
      <span className="music-now-label">Now playing</span>
      <div className="music-now-content">
        {hasTrack ? (
          <div className="track-info">
            <strong>{music!.title}</strong>
            <small>
              {music!.status === 'paused' ? 'Paused' : ''}
              {music!.status === 'paused' && music!.artist ? ' — ' : ''}
              {music!.artist ?? music!.playerName ?? 'Unknown artist'}
            </small>
          </div>
        ) : (
          <span className="music-now-idle">No music playing</span>
        )}
      </div>
    </div>
  );
}

