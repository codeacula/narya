import React from 'react';
import type { OverlayTextPlayback } from '../shared/api';
import { advanceHead, enqueueUnique } from './queue';
import { useSocket } from './realtime';

/** Cap so a redeem storm can't grow the queue without bound. */
export const MAX_OVERLAY_TEXT_QUEUE = 20;

/** Append unless the id is already queued — a replayed socket event must not double-show. */
export function enqueueOverlayText(queue: OverlayTextPlayback[], item: OverlayTextPlayback): OverlayTextPlayback[] {
  return enqueueUnique(
    queue,
    item,
    MAX_OVERLAY_TEXT_QUEUE,
    `Overlay text: queue is full (${MAX_OVERLAY_TEXT_QUEUE}), dropping "${item.text}".`,
  );
}

/** Drop the head, but only if `id` still names it. */
export function advanceOverlayText(queue: OverlayTextPlayback[], id: string): OverlayTextPlayback[] {
  return advanceHead(queue, id);
}

export function useOverlayTextQueue() {
  const [queue, setQueue] = React.useState<OverlayTextPlayback[]>([]);

  useSocket<OverlayTextPlayback>('overlay:text', React.useCallback((item) => {
    setQueue(current => enqueueOverlayText(current, item));
  }, []));

  const onFinished = React.useCallback((id: string) => {
    setQueue(current => advanceOverlayText(current, id));
  }, []);

  return { current: queue[0] ?? null, depth: queue.length, onFinished };
}

/**
 * Shows one Action `show_text` step at a time, for its own duration. Renders
 * nothing when idle so the browser source stays fully transparent.
 */
export function OverlayTextStage({ item, onFinished }: { item: OverlayTextPlayback | null; onFinished: (id: string) => void }) {
  React.useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(() => onFinished(item.id), item.durationMs);
    return () => window.clearTimeout(timer);
  }, [item, onFinished]);

  if (!item) return null;

  return (
    <div
      className={`overlay-text-card overlay-text-card--${item.style}${item.tone ? ` overlay-text-card--${item.tone}` : ''}`}
      key={item.id}
    >
      <div className="overlay-text-body">{item.text}</div>
    </div>
  );
}
