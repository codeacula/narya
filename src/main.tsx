import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

type ChatMessage = {
  id: string;
  username: string;
  displayName: string;
  color: string | null;
  message: string;
  receivedAt: string;
  deletedAt: string | null;
  deletedReason: string | null;
  badges: Record<string, string> | null;
  emotes: Record<string, string[]> | null;
  isFirstTimer: boolean;
  isExiting?: boolean;
};

type Role = 'broadcaster' | 'moderator' | 'vip' | 'subscriber' | 'regular';

type ChatModerationEvent = {
  type: 'message.deleted' | 'user.timeout' | 'user.ban' | 'chat.clear';
  channel: string;
  messageId?: string;
  username?: string;
  deletedAt: string;
  deletedReason: string;
};

type MusicInfo = {
  status: 'playing' | 'paused' | 'stopped' | 'unavailable';
  playerName: string | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  source: 'playerctl' | 'manual' | 'none';
  updatedAt: string;
};

type SoundPlayback = {
  id: string;
  src: string;
  volume?: number;
};

function getRole(badges: Record<string, string> | null): Role {
  if (!badges) return 'regular';
  if (badges.broadcaster) return 'broadcaster';
  if (badges.moderator) return 'moderator';
  if (badges.vip) return 'vip';
  if (badges.subscriber) return 'subscriber';
  return 'regular';
}

function renderWords(text: string, emoteMap: Record<string, string>, baseKey: number): React.ReactNode[] {
  return text.split(/(\s+)/).map((part, i) =>
    emoteMap[part] ? (
      <img key={`bttv-${baseKey}-${i}`} className="chatEmote" src={emoteMap[part]} alt={part} title={part} />
    ) : (
      part
    )
  );
}

function renderContent(
  text: string,
  twitchEmotes: Record<string, string[]> | null,
  emoteMap: Record<string, string>
): React.ReactNode {
  type Range = { start: number; end: number; url: string; name: string };
  const ranges: Range[] = [];

  if (twitchEmotes) {
    for (const [emoteId, positions] of Object.entries(twitchEmotes)) {
      const url = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`;
      for (const pos of positions) {
        const [start, end] = pos.split('-').map(Number);
        ranges.push({ start, end, url, name: text.slice(start, end + 1) });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (cursor < range.start) nodes.push(...renderWords(text.slice(cursor, range.start), emoteMap, cursor));
    nodes.push(
      <img key={`t-${range.start}`} className="chatEmote" src={range.url} alt={range.name} title={range.name} />
    );
    cursor = range.end + 1;
  }

  if (cursor < text.length) nodes.push(...renderWords(text.slice(cursor), emoteMap, cursor));

  return nodes;
}

const scenes = ['Coding', 'BRB', 'Starting Soon', 'Ending'];
const soundButtons = ['Airhorn', 'Bonk', 'Applause', 'Vine Boom'];
const overlayChatExpireMs = 14_000;
const overlayChatFadeMs = 450;
const quackSoundSources = [
  '/sounds/quacks/075176_duck-quack-40345.mp3',
  '/sounds/quacks/duck-quack-112941.mp3',
  '/sounds/quacks/duck-quacking-37392.mp3'
];

function useSocket<T>(event: string, onPayload: (payload: T) => void) {
  React.useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/socket`);

    socket.addEventListener('message', (messageEvent) => {
      const data = JSON.parse(messageEvent.data);
      if (data.event === event) {
        onPayload(data.payload);
      }
    });

    return () => socket.close();
  }, [event, onPayload]);
}

function useChat(expireAfterMs = 0) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);

  React.useEffect(() => {
    if (expireAfterMs > 0) return; // overlay: start empty, only show live messages
    fetch('/api/chat/recent')
      .then((response) => response.json())
      .then((data: ChatMessage[]) => setMessages(data.map((m) => ({ ...m, isFirstTimer: false }))))
      .catch(() => setMessages([]));
  }, [expireAfterMs]);

  useSocket<ChatMessage>(
    'chat:message',
    React.useCallback(
      (message) => {
        setMessages((current) => [...current.slice(-39), message]);
        if (expireAfterMs > 0) {
          setTimeout(() => {
            setMessages((current) => current.map((m) => (m.id === message.id ? { ...m, isExiting: true } : m)));
          }, expireAfterMs);
          setTimeout(() => {
            setMessages((current) => current.filter((m) => m.id !== message.id));
          }, expireAfterMs + overlayChatFadeMs);
        }
      },
      [expireAfterMs]
    )
  );

  useSocket<ChatModerationEvent>(
    'chat:moderated',
    React.useCallback((event) => {
      setMessages((current) =>
        current.map((message) => {
          const matchesMessage = event.messageId && message.id === event.messageId;
          const matchesUser =
            event.username && message.username.toLowerCase() === event.username.toLowerCase();
          const matchesClear = event.type === 'chat.clear';

          if (!matchesMessage && !matchesUser && !matchesClear) return message;

          return { ...message, deletedAt: event.deletedAt, deletedReason: event.deletedReason };
        })
      );
    }, [])
  );

  return messages;
}


function useMusic() {
  const [music, setMusic] = React.useState<MusicInfo | null>(null);

  React.useEffect(() => {
    fetch('/api/music/current')
      .then((response) => response.json())
      .then(setMusic)
      .catch(() => setMusic(null));
  }, []);

  useSocket<MusicInfo>(
    'music:updated',
    React.useCallback((nextMusic) => {
      setMusic(nextMusic);
    }, [])
  );

  return music;
}

function useEmotes() {
  const [emoteMap, setEmoteMap] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    fetch('/api/emotes')
      .then((r) => r.json())
      .then(setEmoteMap)
      .catch(() => {});
  }, []);

  return emoteMap;
}

function useSoundEvents(audioRefs: React.RefObject<Record<string, HTMLAudioElement | null>>) {
  useSocket<SoundPlayback>(
    'sound:play',
    React.useCallback((sound) => {
      const audio = audioRefs.current[sound.src] ?? new Audio(sound.src);
      audio.volume = Math.max(0, Math.min(1, sound.volume ?? 1));
      audio.currentTime = 0;
      void audio.play().catch((error: unknown) => {
        console.error('Failed to play sound:', error);
      });
    }, [audioRefs])
  );
}

function ChatPanel({ compact = false }: { compact?: boolean }) {
  const messages = useChat(compact ? overlayChatExpireMs : 0);
  const emoteMap = useEmotes();
  const visibleMessages = compact ? messages.filter((m) => !m.deletedAt) : messages;

  return (
    <section className={compact ? 'chatPanel compact' : 'chatPanel'}>
      {visibleMessages.length === 0 && !compact ? (
        <p className="muted">Waiting for Twitch chat…</p>
      ) : null}
      {visibleMessages.map((message) => {
        const role = getRole(message.badges);
        const isMention = message.message.toLowerCase().includes('codeacula');
        const classes = [
          'chatMessage',
          message.deletedAt ? 'moderated' : '',
          message.isFirstTimer ? 'firstTime' : '',
          isMention ? 'mention' : '',
          message.isExiting ? 'exiting' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <article className={classes} data-role={role} key={message.id}>
            <strong style={{ color: message.color ?? 'var(--gold)' }}>{message.displayName}</strong>
            <span>{renderContent(message.message, message.emotes, emoteMap)}</span>
            {message.deletedAt ? <em>{message.deletedReason ?? 'moderated'}</em> : null}
          </article>
        );
      })}
    </section>
  );
}

function MusicPanel() {
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

function OverlayPage() {
  const audioRefs = React.useRef<Record<string, HTMLAudioElement | null>>({});
  useSoundEvents(audioRefs);

  return (
    <main className="overlayFrame">
      <div className="soundBank" aria-hidden="true">
        {quackSoundSources.map((src) => (
          <audio
            key={src}
            preload="auto"
            ref={(audio) => {
              audioRefs.current[src] = audio;
            }}
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

async function post(path: string) {
  await fetch(path, { method: 'POST' });
}

function MusicControls() {
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
    const response = await fetch('/api/music/current', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist, status })
    });
    if (response.ok) setIsDirty(false);
  }

  async function clearMusic() {
    const response = await fetch('/api/music/current', { method: 'DELETE' });
    if (response.ok) setIsDirty(false);
  }

  return (
    <section>
      <h2>Now Playing</h2>
      <form className="musicControls" onSubmit={saveMusic}>
        <label>
          <span>Title</span>
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setIsDirty(true);
            }}
          />
        </label>
        <label>
          <span>Artist</span>
          <input
            value={artist}
            onChange={(event) => {
              setArtist(event.target.value);
              setIsDirty(true);
            }}
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as MusicInfo['status']);
              setIsDirty(true);
            }}
          >
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

function ControlSurface({ tablet = false }: { tablet?: boolean }) {
  return (
    <div className={tablet ? 'controlSurface tablet' : 'controlSurface'}>
      <MusicControls />

      <section>
        <h2>Scenes</h2>
        <div className="buttonGrid">
          {scenes.map((scene) => (
            <button key={scene} onClick={() => post(`/api/obs/scenes/${encodeURIComponent(scene)}`)}>
              {scene}
            </button>
          ))}
          <button className="accent" onClick={() => post('/api/obs/transition')}>
            Transition
          </button>
        </div>
      </section>

      <section>
        <h2>Moderation</h2>
        <div className="buttonGrid">
          <button>Clear Chat</button>
          <button>Followers Only</button>
          <button>Slow Mode</button>
          <button>Mark Clip</button>
        </div>
      </section>

      <section>
        <h2>Sounds</h2>
        <div className="buttonGrid">
          {soundButtons.map((sound) => (
            <button key={sound}>{sound}</button>
          ))}
        </div>
      </section>
    </div>
  );
}

function DashboardPage() {
  return (
    <main className="appShell">
      <header>
        <div>
          <span className="eyebrow">codeacula</span>
          <h1>Stream Dashboard</h1>
        </div>
        <nav>
          <a href="/overlay">Overlay</a>
          <a href="/tablet">Tablet</a>
        </nav>
      </header>
      <div className="dashboardGrid">
        <ControlSurface />
        <ChatPanel />
      </div>
    </main>
  );
}

function TabletPage() {
  return (
    <main className="tabletShell">
      <header>
        <h1>Stream Controls</h1>
        <a href="/dashboard">Dashboard</a>
      </header>
      <ControlSurface tablet />
    </main>
  );
}

function App() {
  const path = window.location.pathname;

  React.useEffect(() => {
    document.documentElement.classList.toggle('overlayPage', path === '/overlay');
    document.body.classList.toggle('overlayPage', path === '/overlay');
    return () => {
      document.documentElement.classList.remove('overlayPage');
      document.body.classList.remove('overlayPage');
    };
  }, [path]);

  if (path === '/overlay') return <OverlayPage />;
  if (path === '/tablet') return <TabletPage />;
  return <DashboardPage />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
