import type { ModuleEntry } from './context';
import { Chat } from './Chat';
import { EventFeed } from './EventFeed';

/**
 * Panels the dashboard mounts through `slot(id)` and the pop-out windows. Only what a
 * layout actually mounts belongs here: an entry nothing mounts is dead code that reads
 * as a live panel. (Quick actions was registered in 622a5ff but no layout ever gave it
 * a slot; manual triggers live on the tablet's Quick actions panel.)
 */
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
};
