import { QuickActionsPanel } from '../../quickActions';
import type { ModuleEntry } from './context';
import { Chat } from './Chat';
import { EventFeed } from './EventFeed';

export const MODULES: Record<string, ModuleEntry> = {
  chat: {
    title: 'chat',
    dot: true,
    footer: true,
    count: ctx => ctx.chat.length,
    render: ctx => <Chat ctx={ctx} canModerate />,
  },
  events: {
    title: 'activity feed',
    dot: true,
    count: ctx => ctx.events.length,
    render: ctx => <EventFeed ctx={ctx} />,
  },
  quickActions: {
    title: 'quick actions',
    dot: false,
    render: () => <QuickActionsPanel />,
  },
};
