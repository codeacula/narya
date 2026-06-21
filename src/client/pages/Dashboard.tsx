import React, { useState, useEffect } from 'react';
import { NavBar, StatBar, Panel, PopWindow } from '../ui/shell';
import { ChatInput, MODULES, PanelCtx } from '../ui/panels';
import { useTweaks, TweaksPanel, TweakSection } from '../ui/tweaks';
import { Icon } from '../ui/icons';
import {
  disconnectTwitch,
  getViewers,
  getChatEntries,
  getChatEntriesBefore,
  getStreamEvents,
  getDashboardStatus,
  getStreamInfo,
  getCategorySuggestions,
  getTagSuggestions,
  updateStreamInfo,
  runPrerollAds,
} from '../services/dashboard';
import { useSocket, type ChatMessage as LiveChatMessage, type ChatModerationEvent } from '../legacy';
import type { Viewer, ChatEntry, StreamEvent, DashboardStatus, TwitchCategorySuggestion } from '../../shared/api';

/* ---------------- constants ---------------- */

type Tweaks = {
  layout: string;
  density: string;
  clock: string;
  accent: string;
  starfield: boolean;
};

const TWEAK_DEFAULTS: Tweaks = {
  layout: 'cockpit',
  density: 'dense',
  clock: '12h',
  accent: '#ffb86c',
  starfield: true,
};

const ACCENTS: Record<string, { fg: string; soft: string; border: string }> = {
  '#ffb86c': { fg: '#ffc488', soft: 'rgba(255,184,108,0.12)', border: 'rgba(255,184,108,0.45)' },
  '#9e82e8': { fg: '#bca6f0', soft: 'rgba(158,130,232,0.14)', border: 'rgba(158,130,232,0.45)' },
  '#6aa8d4': { fg: '#9ccae8', soft: 'rgba(106,168,212,0.14)', border: 'rgba(106,168,212,0.45)' },
};

const POP_DEFAULTS: Record<string, { w: number; h: number }> = {
  chat:      { w: 380, h: 540 },
  events:    { w: 360, h: 460 },
};

type PoppedState = { x: number; y: number; w: number; h: number };
type StreamInfoForm = { title: string; category: string; tags: string[] };

const EMPTY_STATUS: DashboardStatus = {
  channel: '',
  chatConnection: 'UNKNOWN',
  obsConnected: false,
  eventSubConnected: false,
  twitchAuthenticated: false,
  twitchAuthSource: null,
  twitchTokenExpiresAt: null,
  twitchMissingScopes: [],
  streamActive: null,
  uptimeSeconds: null,
  streamStartedAt: null,
  uptimeSource: null,
  activeChatters: 0,
  sessionChatters: 0,
  knownChatters: 0,
  bitrateKbps: null,
  congestion: null,
  totalFrames: null,
  droppedFrames: null,
  laggedFrames: null,
  adBreakEndsAt: null,
  adScheduleStatus: 'not_configured',
  adScheduleError: null,
  nextAdAt: null,
  lastAdAt: null,
  adBreakDurationSeconds: null,
  prerollFreeTimeSeconds: null,
  snoozeCount: null,
  snoozeRefreshAt: null,
};

/* ---------------- Settings page ---------------- */

function Settings({
  t,
  setTweak,
  status,
  onTwitchLogout,
}: {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void;
  status: DashboardStatus;
  onTwitchLogout: () => void;
}) {
  const missingTwitchScopes = status.twitchMissingScopes.length > 0
    ? status.twitchMissingScopes.join(', ')
    : null;
  const twitchLoginSub = missingTwitchScopes
    ? `Reconnect to grant missing scopes: ${missingTwitchScopes}`
    : status.twitchAuthenticated
      ? `Credentials cached on backend${status.twitchAuthSource ? ` via ${status.twitchAuthSource}` : ''}`
      : 'Login to cache credentials for EventSub, Twitch uptime, and ad schedule data';

  const Row = ({
    label,
    sub,
    children,
  }: {
    label: string;
    sub?: string;
    children: React.ReactNode;
  }) => (
    <div className="set-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="set-label">{label}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="eyebrow" style={{ marginBottom: '6px' }}>settings</div>
        <h2 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 500 }}>
          Control room
        </h2>
        <p className="set-intro">
          Panel preferences — everything here also lives in the Tweaks drawer.
        </p>

        <div className="set-group">
          <div className="set-group-label">Appearance</div>
          <Row label="Layout arrangement" sub="How the dashboard columns are organized">
            <div className="seg">
              {(['cockpit', 'mission', 'modular'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.layout === o ? ' on' : '')}
                  onClick={() => setTweak('layout', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Density" sub="Tighten the rows for a true cockpit feel">
            <div className="seg">
              {(['dense', 'comfy'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.density === o ? ' on' : '')}
                  onClick={() => setTweak('density', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Status accent" sub="Tint for live, focus, and highlights">
            <div className="seg">
              {([['#ffb86c', 'gold'], ['#9e82e8', 'arcane'], ['#6aa8d4', 'celestial']] as const).map(
                ([c, n]) => (
                  <button
                    key={c}
                    className={'seg-b' + (t.accent === c ? ' on' : '')}
                    onClick={() => setTweak('accent', c)}
                  >
                    <span className="swatch" style={{ background: c }} />
                    {n}
                  </button>
                ),
              )}
            </div>
          </Row>
        </div>

        <div className="set-group">
          <div className="set-group-label">Top bar</div>
          <Row label="Clock format">
            <div className="seg">
              {(['12h', '24h'] as const).map(o => (
                <button
                  key={o}
                  className={'seg-b' + (t.clock === o ? ' on' : '')}
                  onClick={() => setTweak('clock', o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Starfield behind stats" sub="A faint drift of stars under the gauges">
            <button
              className={'toggle' + (t.starfield ? ' on' : '')}
              onClick={() => setTweak('starfield', !t.starfield)}
            >
              <span className="knob" />
            </button>
          </Row>
        </div>

        <div className="set-group">
          <div className="set-group-label">Twitch connection</div>
          <Row
            label="Twitch login"
            sub={twitchLoginSub}
          >
            {missingTwitchScopes ? (
              <a className="btn-primary" href="/api/auth/twitch?force=1">Reconnect</a>
            ) : status.twitchAuthenticated && status.twitchAuthSource === 'oauth' ? (
              <button className="btn-primary" onClick={onTwitchLogout}>Disconnect</button>
            ) : status.twitchAuthenticated ? (
              <span className="set-badge set-badge--ok">Configured</span>
            ) : (
              <a className="btn-primary" href="/api/auth/twitch">
                Login with Twitch
              </a>
            )}
          </Row>
          <Row
            label="EventSub"
            sub={status.eventSubConnected ? 'Receiving channel events' : 'Not connected — login to enable follows, subs, and alerts'}
          >
            {status.eventSubConnected ? (
              <span className="set-badge set-badge--ok">Connected</span>
            ) : (
              <span className="set-badge">Disconnected</span>
            )}
          </Row>
        </div>

        <p className="set-foot">
          More to come — alerts, hotkeys, OBS scenes. The greatest orbs to ponder are the stars above.
        </p>
      </div>
    </div>
  );
}

function normalizeTagInput(value: string): string {
  return value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
}

function StreamInfoModal({
  form,
  loading,
  saving,
  message,
  error,
  setForm,
  onSubmit,
  onClose,
}: {
  form: StreamInfoForm;
  loading: boolean;
  saving: boolean;
  message: string | null;
  error: string | null;
  setForm: React.Dispatch<React.SetStateAction<StreamInfoForm>>;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const [categorySuggestions, setCategorySuggestions] = React.useState<TwitchCategorySuggestion[]>([]);
  const [categoryLoading, setCategoryLoading] = React.useState(false);
  const [categoryFocused, setCategoryFocused] = React.useState(false);
  const [tagInput, setTagInput] = React.useState('');
  const [tagSuggestions, setTagSuggestions] = React.useState<string[]>([]);
  const [tagLoading, setTagLoading] = React.useState(false);
  const [tagFocused, setTagFocused] = React.useState(false);

  React.useEffect(() => {
    const query = form.category.trim();
    if (query.length < 2 || loading) {
      setCategorySuggestions([]);
      setCategoryLoading(false);
      return;
    }

    let cancelled = false;
    setCategoryLoading(true);
    const timeout = window.setTimeout(() => {
      void getCategorySuggestions(query)
        .then(suggestions => {
          if (!cancelled) setCategorySuggestions(suggestions);
        })
        .catch(() => {
          if (!cancelled) setCategorySuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setCategoryLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [form.category, loading]);

  React.useEffect(() => {
    const query = tagInput.trim();
    if (!query || loading) {
      setTagSuggestions([]);
      setTagLoading(false);
      return;
    }

    let cancelled = false;
    setTagLoading(true);
    const timeout = window.setTimeout(() => {
      void getTagSuggestions(query)
        .then(suggestions => {
          if (!cancelled) {
            const selected = new Set(form.tags.map(tag => tag.toLowerCase()));
            setTagSuggestions(suggestions.filter(tag => !selected.has(tag.toLowerCase())));
          }
        })
        .catch(() => {
          if (!cancelled) setTagSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setTagLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [form.tags, loading, tagInput]);

  const addTag = React.useCallback((value: string) => {
    const tag = normalizeTagInput(value);
    if (!tag) return;
    setForm(current => {
      if (current.tags.length >= 10 || current.tags.some(item => item.toLowerCase() === tag.toLowerCase())) {
        return current;
      }
      return { ...current, tags: [...current.tags, tag] };
    });
    setTagInput('');
    setTagSuggestions([]);
  }, [setForm]);

  const removeTag = React.useCallback((tag: string) => {
    setForm(current => ({ ...current, tags: current.tags.filter(item => item !== tag) }));
  }, [setForm]);
  const showCategorySuggestions = categoryFocused && (categoryLoading || categorySuggestions.length > 0);
  const showTagSuggestions = tagFocused && (tagLoading || tagSuggestions.length > 0);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="stream-info-modal" onSubmit={onSubmit}>
        <div className="modal-head">
          <div>
            <h2>Stream Info</h2>
          </div>
          <button className="icon-btn" type="button" title="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <label className="field">
          <span>Title</span>
          <input
            value={form.title}
            maxLength={140}
            disabled={loading || saving}
            onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
          />
          <small>{form.title.length}/140</small>
        </label>

        <div className="field">
          <span>Category</span>
          <div className="suggestion-anchor">
            <input
              aria-label="Category"
              value={form.category}
              disabled={loading || saving}
              onFocus={() => setCategoryFocused(true)}
              onBlur={() => window.setTimeout(() => setCategoryFocused(false), 120)}
              onChange={event => setForm(current => ({ ...current, category: event.target.value }))}
            />
            {showCategorySuggestions && (
              <div className="suggestion-list">
                {categoryLoading ? (
                  <div className="suggestion-empty">Searching categories...</div>
                ) : categorySuggestions.map(category => (
                  <button
                    key={category.id}
                    type="button"
                    className="suggestion-item"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => {
                      setForm(current => ({ ...current, category: category.name }));
                      setCategorySuggestions([]);
                      setCategoryFocused(false);
                    }}
                  >
                    <span>{category.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="field">
          <span>Tags</span>
          <div className="tag-chip-list">
            {form.tags.map(tag => (
              <span className="tag-chip" key={tag}>
                {tag}
                <button type="button" title={`Remove ${tag}`} onClick={() => removeTag(tag)}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
          <div className="suggestion-anchor">
            <input
              aria-label="Tag suggestion"
              value={tagInput}
              disabled={loading || saving || form.tags.length >= 10}
              onFocus={() => setTagFocused(true)}
              onBlur={() => window.setTimeout(() => setTagFocused(false), 120)}
              onChange={event => setTagInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag(tagInput);
                }
              }}
            />
            {showTagSuggestions && (
              <div className="suggestion-list">
                {tagLoading ? (
                  <div className="suggestion-empty">Searching tags...</div>
                ) : tagSuggestions.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className="suggestion-item"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => addTag(tag)}
                  >
                    <span>{tag}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <small>{form.tags.length}/10</small>
        </div>

        {(loading || message || error) && (
          <div className={'modal-status' + (error ? ' error' : '')}>
            {loading ? 'Loading current stream info…' : error ?? message}
          </div>
        )}

        <div className="modal-actions">
          <button className="modbtn" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modbtn gold" type="submit" disabled={loading || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
/* ---------------- Dashboard page ---------------- */

export function DashboardPage() {
  const [t, setTweak] = useTweaks<Tweaks>(TWEAK_DEFAULTS);
  const [page, setPage] = useState('dashboard');
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [popped, setPopped] = useState<Record<string, PoppedState>>({});
  const [viewers, setViewers] = useState<Record<string, Viewer>>({});
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<DashboardStatus>(EMPTY_STATUS);
  const [streamInfoOpen, setStreamInfoOpen] = useState(false);
  const [streamInfoForm, setStreamInfoForm] = useState<StreamInfoForm>({ title: '', category: '', tags: [] });
  const [streamInfoLoading, setStreamInfoLoading] = useState(false);
  const [streamInfoSaving, setStreamInfoSaving] = useState(false);
  const [streamInfoMessage, setStreamInfoMessage] = useState<string | null>(null);
  const [streamInfoError, setStreamInfoError] = useState<string | null>(null);
  const [prerollBusy, setPrerollBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refreshAll = async () => {
      try {
        const [nextViewers, nextChat, nextEvents, nextStatus] = await Promise.all([
          getViewers(),
          getChatEntries(),
          getStreamEvents(),
          getDashboardStatus(),
        ]);
        if (cancelled) return;
        setViewers(nextViewers);
        setChat(nextChat);
        setEvents(nextEvents);
        setStatus(nextStatus);
      } catch {
        if (!cancelled) setStatus(current => ({ ...current, chatConnection: 'UNKNOWN' }));
      }
    };

    const refreshStatus = async () => {
      try {
        const nextStatus = await getDashboardStatus();
        if (!cancelled) setStatus(nextStatus);
      } catch {
        if (!cancelled) setStatus(current => ({ ...current, chatConnection: 'UNKNOWN' }));
      }
    };

    void refreshAll();
    const fullRefresh = setInterval(refreshAll, 30_000);
    const statusRefresh = setInterval(refreshStatus, 5_000);

    return () => {
      cancelled = true;
      clearInterval(fullRefresh);
      clearInterval(statusRefresh);
    };
  }, []);

  useEffect(() => {
    const a = ACCENTS[t.accent] ?? ACCENTS['#ffb86c'];
    const s = document.documentElement.style;
    s.setProperty('--accent', t.accent);
    s.setProperty('--accent-fg', a.fg);
    s.setProperty('--accent-soft', a.soft);
    s.setProperty('--border-3', a.border);
  }, [t.accent]);

  // Real Twitch EventSub events from the backend
  useSocket<StreamEvent>('stream:event', React.useCallback((evt) => {
    setEvents(evs => evs.some(existing => existing.id === evt.id) ? evs : [evt, ...evs.slice(0, 49)]);
  }, []));

  useSocket<LiveChatMessage>('chat:message', React.useCallback((message) => {
    const login = message.username.toLowerCase();
    const nextEntry: ChatEntry = {
      id: message.id,
      user: login,
      text: message.message,
      time: new Date(message.receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      highlight: message.isFirstTimer ? 'first' : message.badges?.subscriber ? 'sub' : undefined,
    };

    setChat(current => current.some(entry => entry.id === nextEntry.id) ? current : [...current, nextEntry]);
    void getViewers().then(setViewers).catch(() => {});
    void getDashboardStatus().then(setStatus).catch(() => {});
  }, []));

  useSocket<ChatModerationEvent>('chat:moderated', React.useCallback(() => {
    void Promise.all([getChatEntries(), getViewers()]).then(([nextChat, nextViewers]) => {
      setChat(nextChat);
      setViewers(nextViewers);
    }).catch(() => {});
  }, []));

  useSocket<DashboardStatus>('dashboard:status', React.useCallback((nextStatus) => {
    setStatus(nextStatus);
  }, []));

  const handleTwitchLogout = React.useCallback(() => {
    void disconnectTwitch()
      .then(() => getDashboardStatus())
      .then(setStatus)
      .catch(() => {});
  }, []);

  const refreshDashboardStatus = React.useCallback(() => {
    void getDashboardStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    const timeUntil = (value: string | null) => {
      if (!value) return null;
      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) return null;
      const remaining = timestamp - Date.now();
      return remaining > 0 ? remaining : 250;
    };

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const adBreakMs = timeUntil(status.adBreakEndsAt);
    if (adBreakMs !== null) {
      timers.push(setTimeout(refreshDashboardStatus, Math.min(adBreakMs + 500, 2_147_483_647)));
    }
    if (status.prerollFreeTimeSeconds !== null && status.prerollFreeTimeSeconds > 0) {
      timers.push(setTimeout(refreshDashboardStatus, Math.min(status.prerollFreeTimeSeconds * 1000 + 500, 2_147_483_647)));
    }
    const nextAdMs = timeUntil(status.nextAdAt);
    if (nextAdMs !== null) {
      timers.push(setTimeout(refreshDashboardStatus, Math.min(nextAdMs + 500, 2_147_483_647)));
    }

    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [refreshDashboardStatus, status.adBreakEndsAt, status.nextAdAt, status.prerollFreeTimeSeconds]);

  const handleRunPreroll = React.useCallback(() => {
    setPrerollBusy(true);
    setActionMessage(null);
    void runPrerollAds()
      .then(result => {
        const minutes = Math.round(result.durationSeconds / 60);
        setActionMessage(`${minutes}m ads started`);
        refreshDashboardStatus();
      })
      .catch(error => {
        setActionMessage(error instanceof Error ? error.message : 'Ad request failed');
      })
      .finally(() => setPrerollBusy(false));
  }, [refreshDashboardStatus]);

  const handleOpenStreamInfo = React.useCallback(() => {
    setStreamInfoOpen(true);
    setStreamInfoLoading(true);
    setStreamInfoMessage(null);
    setStreamInfoError(null);
    void getStreamInfo()
      .then(info => {
        setStreamInfoForm({
          title: info.title,
          category: info.category,
          tags: info.tags,
        });
      })
      .catch(error => {
        setStreamInfoError(error instanceof Error ? error.message : 'Could not load stream info');
      })
      .finally(() => setStreamInfoLoading(false));
  }, []);

  const handleStreamInfoSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStreamInfoSaving(true);
    setStreamInfoMessage(null);
    setStreamInfoError(null);
    void updateStreamInfo({
      title: streamInfoForm.title,
      category: streamInfoForm.category,
      tags: streamInfoForm.tags,
    })
      .then(() => {
        setStreamInfoMessage('Saved');
        setActionMessage('Stream info saved');
        refreshDashboardStatus();
      })
      .catch(error => {
        setStreamInfoError(error instanceof Error ? error.message : 'Could not save stream info');
      })
      .finally(() => setStreamInfoSaving(false));
  }, [refreshDashboardStatus, streamInfoForm]);

  const ctx: PanelCtx = {
    viewers,
    chat,
    events,
    channel: status.channel,
    openViewerPopout: login => {
      const windowName = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.open(`/viewer?login=${encodeURIComponent(login)}`, windowName, 'width=380,height=560');
    },
    loadOlderChat: async () => {
      const oldest = chat[0];
      if (!oldest) return false;
      const older = await getChatEntriesBefore(oldest.id);
      if (older.length === 0) return false;
      setChat(current => [...older, ...current]);
      return older.length === 80; // still more if a full page came back
    },
  };

  const handlePop = (id: string, on: boolean) => {
    setPopped(p => {
      const next = { ...p };
      if (on) {
        const n = Object.keys(p).length;
        const d = POP_DEFAULTS[id] ?? { w: 360, h: 440 };
        next[id] = { x: 160 + n * 34, y: 150 + n * 34, ...d };
      } else {
        delete next[id];
      }
      return next;
    });
  };

  function slot(id: string, className = '') {
    const m = MODULES[id];
    const footer = m.footer ? <ChatInput channel={status.channel} /> : undefined;
    return (
      <Panel
        id={id}
        title={m.title}
        dot={m.dot}
        count={m.count ? m.count(ctx) : undefined}
        popped={!!popped[id]}
        onPop={handlePop}
        className={className}
        footer={footer}
        bodyClass={id === 'chat' ? 'no-pad' : ''}
      >
        {m.render(ctx)}
      </Panel>
    );
  }

  const layouts: Record<string, React.ReactNode> = {
    cockpit: (
      <div className="stage stage--cockpit">
        {slot('chat')}
        <div className="col-stack">
          {slot('events')}
        </div>
      </div>
    ),
    mission: (
      <div className="stage stage--mission">
        {slot('events', 'area-events-rail')}
        {slot('chat')}
      </div>
    ),
    modular: (
      <div className="stage stage--modular">
        {slot('chat')}
        <div className="modgrid">
          <div className="area-events" style={{ display: 'grid', minHeight: 0 }}>
            {slot('events')}
          </div>
        </div>
      </div>
    ),
  };

  return (
    <div className={'cockpit' + (t.density === 'comfy' ? ' comfy' : '')}>
      <NavBar
        page={page}
        setPage={setPage}
        tweaksOpen={tweaksOpen}
        onTweaksToggle={() => setTweaksOpen(o => !o)}
        channel={status.channel}
      />
      <StatBar
        clock24={t.clock === '24h'}
        starfield={t.starfield}
        onRunPreroll={handleRunPreroll}
        onOpenStreamInfo={handleOpenStreamInfo}
        prerollBusy={prerollBusy}
        actionMessage={actionMessage}
        twitchMissingScopes={status.twitchMissingScopes}
        streamActive={status.streamActive}
        uptimeSeconds={status.uptimeSeconds}
        uptimeSource={status.uptimeSource}
        activeChatters={status.activeChatters}
        sessionChatters={status.sessionChatters}
        knownChatters={status.knownChatters}
        bitrateKbps={status.bitrateKbps}
        congestion={status.congestion}
        totalFrames={status.totalFrames}
        droppedFrames={status.droppedFrames}
        laggedFrames={status.laggedFrames}
        adBreakEndsAt={status.adBreakEndsAt}
        adScheduleStatus={status.adScheduleStatus}
        adScheduleError={status.adScheduleError}
        nextAdAt={status.nextAdAt}
        adBreakDurationSeconds={status.adBreakDurationSeconds}
        prerollFreeTimeSeconds={status.prerollFreeTimeSeconds}
        snoozeCount={status.snoozeCount}
        chatConnection={status.chatConnection}
        obsConnected={status.obsConnected}
        eventSubConnected={status.eventSubConnected}
      />
      {page === 'dashboard' ? (layouts[t.layout] ?? layouts['cockpit']) : (
        <Settings t={t} setTweak={setTweak} status={status} onTwitchLogout={handleTwitchLogout} />
      )}

      <div className="popout-layer">
        {Object.keys(popped).map(id => {
          const m = MODULES[id];
          return (
            <PopWindow
              key={id}
              id={id}
              title={m.title}
              initial={popped[id]}
              onClose={x => handlePop(x, false)}
              footer={m.footer ? <ChatInput channel={status.channel} /> : undefined}
            >
              {m.render(ctx)}
            </PopWindow>
          );
        })}
      </div>

      {streamInfoOpen && (
        <StreamInfoModal
          form={streamInfoForm}
          loading={streamInfoLoading}
          saving={streamInfoSaving}
          message={streamInfoMessage}
          error={streamInfoError}
          setForm={setStreamInfoForm}
          onSubmit={handleStreamInfoSubmit}
          onClose={() => setStreamInfoOpen(false)}
        />
      )}

      <TweaksPanel title="Display" open={tweaksOpen} onClose={() => setTweaksOpen(false)}>
        <TweakSection label="Live Data" />
        <div className="live-data-list">
          <div><span>Channel</span><b>{status.channel || 'unavailable'}</b></div>
          <div><span>Chat</span><b>{status.chatConnection.toLowerCase()}</b></div>
          <div><span>EventSub</span><b>{status.eventSubConnected ? 'open' : 'closed'}</b></div>
          <div><span>OBS</span><b>{status.obsConnected ? 'connected' : 'unavailable'}</b></div>
        </div>
      </TweaksPanel>
    </div>
  );
}
