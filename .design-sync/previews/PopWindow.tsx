import * as React from 'react';
import { PopWindow, Chat, ChatInput } from 'streamer-tools';
import { CTX } from './_fixtures';

// `.popwin` is `position: absolute` and lives inside the dashboard's
// `.popout-layer`. A relatively-positioned cockpit surface stands in for that
// layer so `initial` resolves against the card instead of the page.
const Cockpit = ({ children, w = 860, h = 520 }: { children: React.ReactNode; w?: number; h?: number }) => (
  <div
    className="cockpit"
    style={{
      position: 'relative',
      width: w,
      height: h,
      padding: 0,
      border: '1px solid var(--border-1)',
      borderRadius: 'var(--radius-3)',
      overflow: 'hidden',
    }}
  >
    {children}
  </div>
);

// The chat module popped out of the dashboard grid: the module body is the
// window body and the module's own footer (ChatInput) is the window footer.
export const ChatPopout = () => (
  <Cockpit w={570} h={500}>
    <PopWindow
      id="chat"
      title="chat"
      initial={{ x: 24, y: 20, w: 520, h: 460 }}
      onClose={() => undefined}
      footer={<ChatInput channel={CTX.channel} />}
    >
      <Chat ctx={CTX} />
    </PopWindow>
  </Cockpit>
);

// Not every popout carries a footer — a read-only module is head, body and
// the resize grip in the corner.
export const NoFooter = () => (
  <Cockpit w={410} h={290}>
    <PopWindow
      id="status"
      title="live data"
      initial={{ x: 24, y: 20, w: 360, h: 250 }}
      onClose={() => undefined}
    >
      <div style={{ padding: 14 }}>
        <div className="live-data-list">
          <div><span>Channel</span><b>codeacula</b></div>
          <div><span>Chat</span><b>open</b></div>
          <div><span>EventSub</span><b>open</b></div>
          <div><span>OBS</span><b>connected</b></div>
          <div><span>Uptime</span><b>4h 12m</b></div>
          <div><span>Viewers</span><b>342</b></div>
          <div><span>Scene</span><b>Gameplay</b></div>
        </div>
      </div>
    </PopWindow>
  </Cockpit>
);

// The minimum the drag/resize handlers enforce is 280x200 — the window still
// has to read as a window at that size.
export const Minimum = () => (
  <Cockpit w={330} h={240}>
    <PopWindow
      id="shoutouts"
      title="shoutouts"
      initial={{ x: 24, y: 20, w: 280, h: 200 }}
      onClose={() => undefined}
    >
      <div style={{ padding: 14 }}>
        <div className="live-data-list">
          <div><span>LanternKeeper</span><b>raid · 42</b></div>
          <div><span>Emberwright</span><b>sub · T1</b></div>
          <div><span>quietmoth</span><b>follow</b></div>
        </div>
      </div>
    </PopWindow>
  </Cockpit>
);

// Several modules popped at once is the normal end state of a session — each
// window keeps its own position, so they overlap by design.
export const Stacked = () => (
  <Cockpit w={770} h={470}>
    <PopWindow
      id="chat"
      title="chat"
      initial={{ x: 20, y: 16, w: 470, h: 420 }}
      onClose={() => undefined}
      footer={<ChatInput channel={CTX.channel} />}
    >
      <Chat ctx={CTX} />
    </PopWindow>
    <PopWindow
      id="status"
      title="live data"
      initial={{ x: 400, y: 190, w: 340, h: 230 }}
      onClose={() => undefined}
    >
      <div style={{ padding: 14 }}>
        <div className="live-data-list">
          <div><span>Channel</span><b>codeacula</b></div>
          <div><span>Chat</span><b>open</b></div>
          <div><span>EventSub</span><b>open</b></div>
          <div><span>OBS</span><b>connected</b></div>
        </div>
      </div>
    </PopWindow>
  </Cockpit>
);
