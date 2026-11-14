import type { MusicInfo } from '../shared/api';
import { useLiveValue } from './liveValue';
import { getCurrentMusic } from './services/dashboard';

export function useMusic() {
  const [music] = useLiveValue<MusicInfo | null>(getCurrentMusic, 'music:updated', null);

  return music;
}

function NoteIcon() {
  return (
    <span className="music-now-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 18V5l11-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="17" cy="16" r="3" />
      </svg>
    </span>
  );
}

export function MusicPanel() {
  const music = useMusic();
  const hasTrack = (music?.status === 'playing' || music?.status === 'paused') && music.title;
  const paused = hasTrack && music!.status === 'paused';
  const artist = hasTrack ? (music!.artist ?? music!.playerName) : null;

  return (
    <div className={`music-now${paused ? ' is-paused' : ''}`}>
      <NoteIcon />
      {hasTrack ? (
        <>
          <span className="music-now-text">
            {music!.title}
            {artist ? <span className="music-now-artist"> · {artist}</span> : null}
          </span>
          {paused ? <span className="music-now-paused">paused</span> : null}
        </>
      ) : (
        <span className="music-now-idle">nothing playing</span>
      )}
    </div>
  );
}
