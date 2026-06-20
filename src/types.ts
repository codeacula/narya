// Domain types shared across the app. These match the backend API.

export type Viewer = {
  login: string;
  display: string;
  color: string;
  pronouns: string;
  roles: string[];
  followed: string;
  subbed: string;
  seen: string;
  msgs: number;
  accountAge: string;
  note: string;
  recent: Array<{ t: string; ago: string; kind?: string }>;
};

export type ChatEntry = {
  id: string;
  user: string;
  text: string;
  time: string;
  highlight?: 'first' | 'sub';
};

export type StreamEvent = {
  kind: 'raid' | 'gift' | 'sub' | 'cheer' | 'follow' | 'redeem';
  actor: string;
  detail: string;
  ago: string;
  tone: string;
  receivedAt?: string;
};

export type RunItem = {
  text: string;
  done: boolean;
};

export type DashboardStatus = {
  channel: string;
  chatConnection: 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
  obsConnected: boolean;
  eventSubConnected: boolean;
  streamActive: boolean | null;
  uptimeSeconds: number | null;
  activeChatters: number;
  sessionChatters: number;
  knownChatters: number;
  bitrateKbps: number | null;
  totalFrames: number | null;
  droppedFrames: number | null;
  laggedFrames: number | null;
  nextAdSeconds: number | null;
};
