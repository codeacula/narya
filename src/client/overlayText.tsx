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

const ICON_PROPS = {
  width: 28,
  height: 28,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Line icon per tone, copied from the Alerts mockup. Unknown or absent tones get none. */
function ToneIcon({ tone }: { tone: string | undefined }) {
  switch (tone) {
    case 'silver':
      return <svg {...ICON_PROPS}><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" /></svg>;
    case 'warning':
      return (
        <svg {...ICON_PROPS}>
          <circle cx="12" cy="12" r="6" />
          <ellipse cx="12" cy="12" rx="10" ry="3" transform="rotate(-22 12 12)" />
        </svg>
      );
    case 'note':
      return (
        <svg {...ICON_PROPS}>
          <path d="M4 20L20 4" />
          <path d="M13 4h7v7" />
          <path d="M4 12v8h8" />
        </svg>
      );
    case 'info':
      return (
        <svg {...ICON_PROPS}>
          <path d="M12 3l7 9-7 9-7-9z" />
          <path d="M5 12h14" />
        </svg>
      );
    default:
      return null;
  }
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

  const icon = ToneIcon({ tone: item.tone });

  return (
    <div
      className={`overlay-text-card overlay-text-card--${item.style}${item.tone ? ` overlay-text-card--${item.tone}` : ''}`}
      key={item.id}
    >
      {icon ? <div className="overlay-text-icon">{icon}</div> : null}
      <div className="overlay-text-body">{item.text}</div>
    </div>
  );
}
