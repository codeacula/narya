declare module 'tmi.js' {
  export type ChatUserstate = {
    id?: string;
    username?: string;
    'display-name'?: string;
    color?: string;
    'target-msg-id'?: string;
    'room-id'?: string;
    badges?: Record<string, string>;
    emotes?: Record<string, string[]>;
  };

  export type ModerationUserstate = {
    'target-msg-id'?: string;
    [key: string]: unknown;
  };

  export class Client {
    constructor(options: {
      connection: { reconnect: boolean; secure: boolean };
      channels: string[];
    });

    connect(): Promise<[string, number]>;
    on(
      event: 'message',
      handler: (channel: string, tags: ChatUserstate, message: string, self: boolean) => void
    ): void;
    on(
      event: 'messagedeleted',
      handler: (channel: string, username: string, deletedMessage: string, tags: ModerationUserstate) => void
    ): void;
    on(
      event: 'timeout',
      handler: (channel: string, username: string, reason: string, duration: number, tags: ModerationUserstate) => void
    ): void;
    on(
      event: 'ban',
      handler: (channel: string, username: string, reason: string, tags: ModerationUserstate) => void
    ): void;
    on(event: 'clearchat', handler: (channel: string) => void): void;
  }

  const tmi: {
    Client: typeof Client;
  };

  export default tmi;
}
