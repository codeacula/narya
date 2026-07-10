import React from 'react';
import type { MusicInfo } from '../shared/api';
import { useSocket } from './realtime';
import { clearManualMusic, getCurrentMusic, setManualMusic } from './services/dashboard';

export function useMusic() {
  const [music, setMusic] = React.useState<MusicInfo | null>(null);

  React.useEffect(() => {
    getCurrentMusic()
      .then(setMusic)
      .catch(() => setMusic(null));
  }, []);

  useSocket<MusicInfo>(
    'music:updated',
    React.useCallback((next) => setMusic(next), []),
  );

  return music;
}

export function MusicPanel() {
  const music = useMusic();
  const hasTrack = (music?.status === 'playing' || music?.status === 'paused') && music.title;

  return (
    <div className="musicNow">
      <span className="musicNowLabel">Now playing</span>
      <div className="musicNowContent">
        {hasTrack ? (
          <div className="trackInfo">
            <strong>{music!.title}</strong>
            <small>
              {music!.status === 'paused' ? 'Paused' : ''}
              {music!.status === 'paused' && music!.artist ? ' — ' : ''}
              {music!.artist ?? music!.playerName ?? 'Unknown artist'}
            </small>
          </div>
        ) : (
          <span className="musicNowIdle">No music playing</span>
        )}
      </div>
    </div>
  );
}

export function MusicControls() {
  const music = useMusic();
  const [title, setTitle] = React.useState('');
  const [artist, setArtist] = React.useState('');
  const [status, setStatus] = React.useState<MusicInfo['status']>('playing');
  const [isDirty, setIsDirty] = React.useState(false);

  React.useEffect(() => {
    if (isDirty) return;
    setTitle(music?.title ?? '');
    setArtist(music?.artist ?? '');
    setStatus(music?.status === 'paused' || music?.status === 'stopped' ? music.status : 'playing');
  }, [isDirty, music]);

  async function saveMusic(event: React.FormEvent) {
    event.preventDefault();
    try {
      await setManualMusic({ title, artist, status });
      setIsDirty(false);
    } catch (error) {
      console.error('Failed to set manual music:', error);
    }
  }

  async function clearMusic() {
    try {
      await clearManualMusic();
      setIsDirty(false);
    } catch (error) {
      console.error('Failed to clear manual music:', error);
    }
  }

  return (
    <section>
      <div className="tabletPanelHeader">
        <div>
          <p className="eyebrow">Music</p>
          <h2>Now Playing</h2>
        </div>
      </div>
      <form className="musicControls" onSubmit={saveMusic}>
        <label>
          <span>Title</span>
          <input value={title} onChange={e => { setTitle(e.target.value); setIsDirty(true); }} />
        </label>
        <label>
          <span>Artist</span>
          <input value={artist} onChange={e => { setArtist(e.target.value); setIsDirty(true); }} />
        </label>
        <label>
          <span>Status</span>
          <select value={status} onChange={e => { setStatus(e.target.value as MusicInfo['status']); setIsDirty(true); }}>
            <option value="playing">Playing</option>
            <option value="paused">Paused</option>
            <option value="stopped">Stopped</option>
          </select>
        </label>
        <div className="musicControlActions">
          <button className="accent" type="submit">Update</button>
          <button type="button" onClick={clearMusic}>Clear manual</button>
        </div>
        <span className="musicSource">
          Source: {music?.source === 'playerctl' ? 'playerctl' : music?.source === 'manual' ? 'manual' : 'none'}
        </span>
      </form>
    </section>
  );
}
