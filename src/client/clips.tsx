import React from 'react';
import type { ClipButton, MediaPlayback } from '../shared/api';
import { getClipButtons } from './services/dashboard';
import { useSocket } from './realtime';

/** Curated clip buttons for the tablet Media panel. */
export function useClipButtons() {
  const [clipButtons, setClipButtons] = React.useState<ClipButton[]>([]);

  React.useEffect(() => {
    getClipButtons()
      .then(setClipButtons)
      .catch((error: unknown) => {
        console.error('Failed to load clip buttons:', error);
      });
  }, []);

  return clipButtons;
}

/** Cap so a redeem storm can't grow the queue without bound. */
const MAX_QUEUE = 20;

/** Append unless the id is already queued — a replayed socket event must not double-play. */
export function enqueue(queue: MediaPlayback[], item: MediaPlayback): MediaPlayback[] {
  if (queue.some(queued => queued.id === item.id)) return queue;
  if (queue.length >= MAX_QUEUE) {
    // The viewer already spent their points and EventSub recorded the redeem, so
    // a silent drop looks like a broken clip. Say so where the operator can see it.
    console.warn(`Clips: queue is full (${MAX_QUEUE}), dropping ${item.src}${item.actor ? ` from ${item.actor}` : ''}.`);
    return queue;
  }
  return [...queue, item];
}

/**
 * Drop the head, but only if `id` still names it. A failing file can both reject
 * play() and fire the element's error event; without this check the two
 * completions would drop two items and swallow the redeem behind the bad one.
 */
export function advance(queue: MediaPlayback[], id: string): MediaPlayback[] {
  if (queue[0]?.id !== id) return queue;
  return queue.slice(1);
}

export function useMediaQueue() {
  const [queue, setQueue] = React.useState<MediaPlayback[]>([]);

  useSocket<MediaPlayback>('media:play', React.useCallback((item) => {
    setQueue(current => enqueue(current, item));
  }, []));

  const onFinished = React.useCallback((id: string) => {
    setQueue(current => advance(current, id));
  }, []);

  return { current: queue[0] ?? null, depth: queue.length, onFinished };
}

/**
 * Plays one media item at a time. Renders nothing when idle so the browser
 * source stays fully transparent.
 *
 * Autoplay: OBS browser sources run with --autoplay-policy=no-user-gesture-required,
 * so audible playback starts on its own. A plain browser tab may reject play()
 * until the page is clicked; we advance past the item rather than wedge the queue.
 */
export function ClipStage({ item, onFinished }: { item: MediaPlayback | null; onFinished: (id: string) => void }) {
  const mediaRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  React.useEffect(() => {
    const element = mediaRef.current;
    if (!item || !element) return;
    element.volume = Math.max(0, Math.min(1, item.volume));
    element.currentTime = 0;
    void element.play().catch((error: unknown) => {
      console.error(`Clips: could not play ${item.src}:`, error);
      onFinished(item.id);
    });
  }, [item, onFinished]);

  if (!item) return null;

  const finish = () => { onFinished(item.id); };

  if (item.kind === 'audio') {
    return (
      <audio
        key={item.id}
        ref={el => { mediaRef.current = el; }}
        src={item.src}
        onEnded={finish}
        onError={finish}
      />
    );
  }

  // The glow and highlight are pseudo-elements, which <video> cannot carry, so
  // the clip plays inside a wrapper that draws them around it.
  return (
    <div className="clipFrame" key={item.id}>
      <video
        ref={el => { mediaRef.current = el; }}
        className="clipVideo"
        src={item.src}
        playsInline
        onEnded={finish}
        onError={finish}
      />
    </div>
  );
}
