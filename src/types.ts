// Domain types shared across the app. These match what the backend will eventually return.

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
  user: string;
  text: string;
  time: string;
  highlight?: 'first' | 'sub';
};

export type StreamEvent = {
  kind: 'raid' | 'gift' | 'sub' | 'cheer' | 'follow';
  actor: string;
  detail: string;
  ago: string;
  tone: string;
};

export type RunItem = {
  text: string;
  done: boolean;
};
