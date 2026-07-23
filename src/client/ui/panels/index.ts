// Barrel that preserves the public surface of the former single-file panels.tsx.
// Consumers import from '../ui/panels' unchanged; the components now live in
// focused files under this directory.
export type { PanelCtx, ModuleEntry, SessionRow } from './context';
export { belongsToCurrentSession, sessionBoundaryIndex } from './context';
export type { ChatRowModerationStatus, ChatRowModeration } from './Chat';
export { ChatMessageRow, Chat, ChatInput } from './Chat';
export { Spotlight } from './Spotlight';
export { ShoutoutsPanel } from './ShoutoutsPanel';
export { AttentionDismissAll, AttentionPanel } from './AttentionPanel';
export { ControlsPanel } from './ControlsPanel';
export type { RecentChatter } from './ChattersPanel';
export { mergeRecentChatters, ChattersPanel } from './ChattersPanel';
export { MODULES } from './modules';
