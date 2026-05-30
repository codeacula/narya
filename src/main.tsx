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
};

type StreamGoal = {
  id: string;
  label: string;
  current: number;
  target: number;
};

const scenes = ['Coding', 'BRB', 'Starting Soon', 'Ending'];
const soundButtons = ['Airhorn', 'Bonk', 'Applause', 'Vine Boom'];

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

function useChat() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);

  React.useEffect(() => {
    fetch('/api/chat/recent')
      .then((response) => response.json())
      .then(setMessages)
      .catch(() => setMessages([]));
  }, []);

  useSocket<ChatMessage>(
    'chat:message',
    React.useCallback((message) => {
      setMessages((current) => [...current.slice(-39), message]);
    }, [])
  );

  return messages;
}

function useGoals() {
  const [goals, setGoals] = React.useState<StreamGoal[]>([]);

  React.useEffect(() => {
    fetch('/api/goals')
      .then((response) => response.json())
      .then(setGoals)
      .catch(() => setGoals([]));
  }, []);

  useSocket<StreamGoal>(
    'goals:updated',
    React.useCallback((goal) => {
      setGoals((current) => current.map((item) => (item.id === goal.id ? goal : item)));
    }, [])
  );

  return [goals, setGoals] as const;
}

function ChatPanel({ compact = false }: { compact?: boolean }) {
  const messages = useChat();

  return (
    <section className={compact ? 'chatPanel compact' : 'chatPanel'}>
      {messages.length === 0 ? (
        <p className="muted">Waiting for Twitch chat...</p>
      ) : (
        messages.map((message) => (
          <article className="chatMessage" key={message.id}>
            <strong style={{ color: message.color ?? '#9bd4ff' }}>{message.displayName}</strong>
            <span>{message.message}</span>
          </article>
        ))
      )}
    </section>
  );
}

function GoalsPanel() {
  const [goals] = useGoals();

  return (
    <section className="goalsPanel">
      <div className="musicNow">
        <span>Now playing</span>
        <strong>Local music hook pending</strong>
      </div>
      {goals.map((goal) => {
        const percent = Math.min(100, Math.round((goal.current / goal.target) * 100));

        return (
          <div className="goal" key={goal.id}>
            <div>
              <span>{goal.label}</span>
              <strong>
                {goal.current}/{goal.target}
              </strong>
            </div>
            <progress max="100" value={percent} />
          </div>
        );
      })}
    </section>
  );
}

function OverlayPage() {
  return (
    <main className="overlayFrame">
      <div className="overlayChat">
        <ChatPanel compact />
      </div>
      <div className="overlayGoals">
        <GoalsPanel />
      </div>
    </main>
  );
}

async function post(path: string) {
  await fetch(path, { method: 'POST' });
}

function ControlSurface({ tablet = false }: { tablet?: boolean }) {
  const [goals, setGoals] = useGoals();

  async function updateGoal(goal: StreamGoal, delta: number) {
    const nextGoal = { ...goal, current: Math.max(0, goal.current + delta) };
    setGoals((current) => current.map((item) => (item.id === goal.id ? nextGoal : item)));

    await fetch(`/api/goals/${goal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextGoal)
    });
  }

  return (
    <div className={tablet ? 'controlSurface tablet' : 'controlSurface'}>
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

      <section>
        <h2>Goals</h2>
        <div className="goalControls">
          {goals.map((goal) => (
            <div className="goalControl" key={goal.id}>
              <strong>{goal.label}</strong>
              <span>
                {goal.current}/{goal.target}
              </span>
              <button onClick={() => updateGoal(goal, -1)}>-</button>
              <button onClick={() => updateGoal(goal, 1)}>+</button>
            </div>
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

  if (path === '/overlay') return <OverlayPage />;
  if (path === '/tablet') return <TabletPage />;
  return <DashboardPage />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
