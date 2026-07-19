import * as React from 'react';
import { StatBar } from 'streamer-tools';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 0, height: 'auto' }}>{children}</div>
);

// Countdowns are relative to render time on purpose: a hardcoded ISO instant
// renders as a nonsense duration once the day it was written has passed.
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

const base = {
  clock24: true,
  starfield: true,
  onGoLive: () => undefined,
  onRunPreroll: () => undefined,
  onOpenStreamInfo: () => undefined,
  goLiveBusy: false,
  prerollBusy: false,
  actionMessage: '',
  twitchMissingScopes: [] as string[],
  streamActive: false,
  uptimeSeconds: 0,
  uptimeSource: 'twitch' as const,
  viewerCount: 0,
  bitrateKbps: 0,
  congestion: 0,
  totalFrames: 0,
  droppedFrames: 0,
  laggedFrames: 0,
  adBreakEndsAt: '',
  adScheduleStatus: 'not_configured' as const,
  adScheduleError: '',
  nextAdAt: '',
  adBreakDurationSeconds: 0,
  prerollFreeTimeSeconds: 0,
  snoozeCount: 0,
  chatConnection: 'CLOSED',
  obsConnected: false,
  eventSubConnected: false,
  eventSubError: '',
  onReconnectEventSub: () => undefined,
};

export const Offline = () => (
  <Cockpit>
    <StatBar {...base} />
  </Cockpit>
);

export const Live = () => (
  <Cockpit>
    <StatBar
      {...base}
      streamActive
      uptimeSeconds={4 * 3600 + 12 * 60}
      viewerCount={342}
      bitrateKbps={6000}
      congestion={0.02}
      totalFrames={620_400}
      droppedFrames={12}
      laggedFrames={3}
      adScheduleStatus="available"
      nextAdAt={inSeconds(18 * 60)}
      adBreakDurationSeconds={90}
      prerollFreeTimeSeconds={120}
      chatConnection="OPEN"
      obsConnected
      eventSubConnected
    />
  </Cockpit>
);

export const Degraded = () => (
  <Cockpit>
    <StatBar
      {...base}
      streamActive
      uptimeSeconds={51 * 60}
      uptimeSource="obs"
      viewerCount={118}
      bitrateKbps={2400}
      congestion={0.44}
      totalFrames={210_000}
      droppedFrames={1840}
      laggedFrames={260}
      adScheduleStatus="missing_scope"
      adScheduleError="channel:read:ads not granted"
      chatConnection="CONNECTING"
      obsConnected
      eventSubConnected={false}
      eventSubError="socket closed (4003)"
      twitchMissingScopes={['channel:read:ads']}
      actionMessage="Reconnecting to EventSub…"
    />
  </Cockpit>
);

export const InAdBreak = () => (
  <Cockpit>
    <StatBar
      {...base}
      streamActive
      uptimeSeconds={2 * 3600 + 5 * 60}
      viewerCount={295}
      bitrateKbps={6000}
      totalFrames={410_000}
      adScheduleStatus="available"
      adBreakEndsAt={inSeconds(90)}
      adBreakDurationSeconds={90}
      snoozeCount={2}
      chatConnection="OPEN"
      obsConnected
      eventSubConnected
    />
  </Cockpit>
);
