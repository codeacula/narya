import * as React from 'react';
import { Chat, ChatInput, Panel } from 'streamer-tools';
import { CHANNEL, CTX } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

/**
 * ChatInput owns its text in local state, so a preview can't seed it by prop.
 * Driving the real DOM input through a native `input` event is how React sees a
 * genuine keystroke — the send button enables exactly as it would for a person
 * typing, rather than being faked with a lookalike.
 */
function Typing({ value, children }: { value: string; children: React.ReactNode }) {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const field = host.current?.querySelector<HTMLInputElement>('.chat-input input');
    if (!field) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, [value]);
  return <div ref={host}>{children}</div>;
}

// Empty: send is disabled, and the placeholder names the channel being posted to.
export const Empty = () => (
  <Cockpit>
    <ChatInput channel={CHANNEL} />
  </Cockpit>
);

// A composed message — send lights up once there is non-whitespace text.
export const Typed = () => (
  <Cockpit>
    <Typing value="thanks for the raid, welcome in everyone!">
      <ChatInput channel={CHANNEL} />
    </Typing>
  </Cockpit>
);

// Anything starting with "/" is an operator command resolved server-side and
// never forwarded to Twitch. The input is the same field either way.
export const SlashCommand = () => (
  <Cockpit>
    <Typing value="/shoutout lanternkeeper">
      <ChatInput channel={CHANNEL} />
    </Typing>
  </Cockpit>
);

// Its real home is the Chat panel's footer slot, pinned below the message list.
export const AsPanelFooter = () => (
  <Cockpit>
    <Panel
      id="chat"
      title="Chat"
      popped={false}
      onPop={() => undefined}
      count={CTX.chat.length}
      footer={<ChatInput channel={CHANNEL} />}
    >
      <Chat ctx={CTX} />
    </Panel>
  </Cockpit>
);
