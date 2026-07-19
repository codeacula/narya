import * as React from 'react';
import { ChatMessageRow, Panel } from 'streamer-tools';
import type { ChatEntry } from '../../src/shared/api';
import { CHANNEL, VIEWERS } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

// Rows are laid out by their scroller in the real Chat panel — stack them in the
// same `.chat-list` so spacing and accent rails read as they do on the dashboard.
const List = ({ children }: { children: React.ReactNode }) => (
  <div className="chat-list" style={{ overflow: 'visible' }}>{children}</div>
);

const msg = (id: string, user: string, text: string, time: string, over: Partial<ChatEntry> = {}): ChatEntry => ({
  id,
  user,
  text,
  time,
  sessionId: 'sess-2026-07-19',
  ...over,
});

const row = (m: ChatEntry, extra: { fromThisStream?: boolean } = {}) => (
  <ChatMessageRow
    key={m.id}
    m={m}
    viewer={VIEWERS[m.user.toLowerCase()]}
    onUserClick={() => undefined}
    channel={CHANNEL}
    {...extra}
  />
);

/**
 * The `highlight` axis is the component's whole reason for existing — each value
 * is a different accent rail and tint, so one lone row shows none of it.
 */
export const HighlightVariants = () => (
  <Cockpit>
    <List>
      {row(msg('h1', 'Codeacula', 'alright, pushing the overlay bounds fix now', '7:13', { highlight: 'broadcaster' }))}
      {row(msg('h2', 'LanternKeeper', 'the placeholder outlines line up perfectly in OBS', '7:13', { highlight: 'mod' }))}
      {row(msg('h3', 'Emberwright', 'wait you can drag the popouts now?', '7:14', { highlight: 'vip' }))}
      {row(msg('h4', 'Emberwright', 'resubbed! 3 months of watching this thing get built', '7:14', { highlight: 'sub' }))}
      {row(msg('h5', 'quietmoth', 'first time catching a stream live — hi!', '7:15', { highlight: 'first-ever' }))}
      {row(msg('h6', 'LanternKeeper', 'back for round two tonight', '7:15', { highlight: 'first-session' }))}
    </List>
  </Cockpit>
);

// No `highlight` at all: the default row, no rail, no tint. Most of chat is this.
export const PlainMessages = () => (
  <Cockpit>
    <List>
      {row(msg('p1', 'Emberwright', 'what font is that in the editor', '7:16'))}
      {row(msg('p2', 'quietmoth', 'the gold accent against the navy is really nice', '7:16'))}
      {row(msg('p3', 'Emberwright', 'docs are at https://github.com/codeacula/narya if anyone wants them', '7:17'))}
    </List>
  </Cockpit>
);

/**
 * Two rows that are structurally different, not just tinted: a whisper takes an
 * early return with its own tag, and a row from an earlier session dims via
 * `fromThisStream={false}` so scrollback can't be mistaken for live chat.
 */
export const WhisperAndPastSession = () => (
  <Cockpit>
    <List>
      {row(msg('w1', 'LanternKeeper', 'heads up, someone is spamming in the raid channel', '7:11', { kind: 'whisper' }))}
      {row(msg('w2', 'Emberwright', 'see you next stream!', '11:48', { sessionId: 'sess-2026-07-17' }), { fromThisStream: false })}
      {row(msg('w3', 'LanternKeeper', 'good stream, get some sleep', '11:49', { sessionId: 'sess-2026-07-17' }), { fromThisStream: false })}
      {row(msg('w4', 'Emberwright', 'back for tonight', '7:12'))}
    </List>
  </Cockpit>
);

/**
 * `channel` turns on the ping check. Both the `@codeacula` and the bare
 * `codeacula` rows take the gold mention rail, which outranks the sender's role
 * tint; the neighbouring rows show what a non-mention looks like — including the
 * operator's own message, which never pings itself, and a URL that merely
 * contains the login, which is not someone talking to you.
 */
export const MentionsOperator = () => (
  <Cockpit>
    <List>
      {row(msg('n0', 'Emberwright', 'this panel layout is growing on me', '7:17'))}
      {row(msg('n1', 'Emberwright', '@codeacula does the mute switch survive a restart?', '7:18'))}
      {row(msg('n2', 'Codeacula', 'it does — it is persisted operator state', '7:18', { highlight: 'broadcaster' }))}
      {row(msg('n3', 'quietmoth', 'codeacula this dashboard is unreasonably pretty', '7:19'))}
      {row(msg('n4', 'LanternKeeper', 'clip is up at twitch.tv/codeacula/clips', '7:20', { highlight: 'mod' }))}
    </List>
  </Cockpit>
);

// In situ: the same rows inside the Chat panel that hosts them.
export const InPanel = () => (
  <Cockpit>
    <Panel id="chat" title="Chat" popped={false} onPop={() => undefined} count={4}>
      <List>
        {row(msg('i1', 'Codeacula', 'stream starting — coffee acquired', '7:02', { highlight: 'broadcaster' }))}
        {row(msg('i2', 'LanternKeeper', 'lets go', '7:02', { highlight: 'mod' }))}
        {row(msg('i3', 'quietmoth', 'first time here, the overlay looks great', '7:03', { highlight: 'first-ever' }))}
        {row(msg('i4', 'Emberwright', 'what are we building today?', '7:04', { highlight: 'vip' }))}
      </List>
    </Panel>
  </Cockpit>
);
