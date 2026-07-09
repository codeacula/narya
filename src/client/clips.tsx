import React from 'react';
import type { MediaPlayback } from '../shared/api';
import { useSocket } from './realtime';

/** Cap so a redeem storm can't grow the queue without bound. */
const MAX_QUEUE = 20;

/** Append unless the id is already queued — a replayed socket event must not double-play. */
export function enqueue(queue: MediaPlayback[], item: MediaPlayback): MediaPlayback[] {
  if (queue.some(queued => queued.id === item.id)) return queue;
  if (queue.length >= MAX_QUEUE) return queue;
  return [...queue, item];
}

/** Drop the head. Called when a clip ends, errors, or can't autoplay. */
export function advance(queue: MediaPlayback[]): MediaPlayback[] {
  return queue.slice(1);
}

export function useMediaQueue() {
  const [queue, setQueue] = React.useState<MediaPlayback[]>([]);

  useSocket<MediaPlayback>('media:play', React.useCallback((item) => {
    setQueue(current => enqueue(current, item));
  }, []));

  const onFinished = React.useCallback(() => {
    setQueue(current => advance(current));
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
export function ClipStage({ item, onFinished }: { item: MediaPlayback | null; onFinished: () => void }) {
  const mediaRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  React.useEffect(() => {
    const element = mediaRef.current;
    if (!item || !element) return;
    element.volume = Math.max(0, Math.min(1, item.volume));
    element.currentTime = 0;
    void element.play().catch((error: unknown) => {
      console.error(`Clips: could not play ${item.src}:`, error);
      onFinished();
    });
  }, [item, onFinished]);

  if (!item) return null;

  if (item.kind === 'audio') {
    return (
      <audio
        key={item.id}
        ref={el => { mediaRef.current = el; }}
        src={item.src}
        onEnded={onFinished}
        onError={onFinished}
      />
    );
  }

  // The rim and highlight are pseudo-elements, which <video> cannot carry, so
  // the clip plays inside a wrapper that draws the glass around it.
  return (
    <div className="clipOrb" key={item.id}>
      <video
        ref={el => { mediaRef.current = el; }}
        className="clipVideo"
        src={item.src}
        playsInline
        onEnded={onFinished}
        onError={onFinished}
      />
    </div>
  );
}
