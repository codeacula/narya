import React from 'react';
import type { OverlayTextPlayback } from '../shared/api';
import { useSocket } from './realtime';

/** Cap so a redeem storm can't grow the queue without bound. */
export const MAX_OVERLAY_TEXT_QUEUE = 20;

/** Append unless the id is already queued — a replayed socket event must not double-show. */
export function enqueueOverlayText(queue: OverlayTextPlayback[], item: OverlayTextPlayback): OverlayTextPlayback[] {
  if (queue.some(queued => queued.id === item.id)) return queue;
  if (queue.length >= MAX_OVERLAY_TEXT_QUEUE) {
    console.warn(`Overlay text: queue is full (${MAX_OVERLAY_TEXT_QUEUE}), dropping "${item.text}".`);
    return queue;
  }
  return [...queue, item];
}

/** Drop the head, but only if `id` still names it. */
export function advanceOverlayText(queue: OverlayTextPlayback[], id: string): OverlayTextPlayback[] {
  if (queue[0]?.id !== id) return queue;
  return queue.slice(1);
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
      className={`overlayTextCard overlayTextCard--${item.style}${item.tone ? ` overlayTextCard--${item.tone}` : ''}`}
      key={item.id}
    >
      <div className="overlayTextBody">{item.text}</div>
    </div>
  );
}
