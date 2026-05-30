declare module 'tmi.js' {
  export type ChatUserstate = {
    id?: string;
    username?: string;
    'display-name'?: string;
    color?: string;
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
  }

  const tmi: {
    Client: typeof Client;
  };

  export default tmi;
}
