import React from 'react';
import type { AlertPlayback } from '../shared/api';
import { useSocket } from './realtime';

/** Cap so an event storm (e.g. a gift-sub spree) can't grow the queue without bound. */
export const MAX_ALERT_QUEUE = 20;

/** Append unless the id is already queued — a replayed socket event must not double-play. */
export function enqueueAlert(queue: AlertPlayback[], item: AlertPlayback): AlertPlayback[] {
  if (queue.some(queued => queued.id === item.id)) return queue;
  if (queue.length >= MAX_ALERT_QUEUE) {
    console.warn(`Alerts: queue is full (${MAX_ALERT_QUEUE}), dropping ${item.kind} alert "${item.text}".`);
    return queue;
  }
  return [...queue, item];
}

/**
 * Drop the head, but only if `id` still names it. A failing clip can both reject
 * play() and fire the element's error event; this guard keeps the two completions
 * from advancing past two items.
 */
export function advanceAlert(queue: AlertPlayback[], id: string): AlertPlayback[] {
  if (queue[0]?.id !== id) return queue;
  return queue.slice(1);
}

export function useAlertQueue() {
  const [queue, setQueue] = React.useState<AlertPlayback[]>([]);

  useSocket<AlertPlayback>('alert:show', React.useCallback((item) => {
    setQueue(current => enqueueAlert(current, item));
  }, []));

  const onFinished = React.useCallback((id: string) => {
    setQueue(current => advanceAlert(current, id));
  }, []);

  return { current: queue[0] ?? null, depth: queue.length, onFinished };
}

/**
 * Shows one alert at a time: a text banner plus optional sound or clip. The alert
 * stays until BOTH its text duration has elapsed and any media has finished, so a
 * short clip never cuts the banner off early and a long clip isn't clipped. Renders
 * nothing when idle so the browser source stays fully transparent.
 *
 * Autoplay: OBS browser sources run with --autoplay-policy=no-user-gesture-required,
 * so audible playback starts on its own. A plain browser tab may reject play() until
 * the page is clicked; we treat that as media-done rather than wedge the queue.
 */
export function AlertStage({ item, onFinished }: { item: AlertPlayback | null; onFinished: (id: string) => void }) {
  const mediaRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  React.useEffect(() => {
    if (!item) return;
    let finished = false;
    let timerDone = false;
    let mediaDone = !item.media; // no media → nothing to wait for
    const finish = () => {
      if (finished) return;
      finished = true;
      onFinished(item.id);
    };
    const maybeFinish = () => {
      if (timerDone && mediaDone) finish();
    };
    const timer = window.setTimeout(() => { timerDone = true; maybeFinish(); }, item.durationMs);

    const element = mediaRef.current;
    if (item.media && element) {
      const onMediaDone = () => { mediaDone = true; maybeFinish(); };
      element.volume = Math.max(0, Math.min(1, item.media.volume));
      element.currentTime = 0;
      element.addEventListener('ended', onMediaDone);
      element.addEventListener('error', onMediaDone);
      void element.play().catch((error: unknown) => {
        console.error(`Alerts: could not play ${item.media?.src}:`, error);
        onMediaDone();
      });
      return () => {
        window.clearTimeout(timer);
        element.removeEventListener('ended', onMediaDone);
        element.removeEventListener('error', onMediaDone);
      };
    }
    return () => window.clearTimeout(timer);
  }, [item, onFinished]);

  if (!item) return null;

  return (
    <div className={`alertCard alertCard--${item.tone}`} key={item.id}>
      {item.media?.kind === 'video' && (
        <video
          ref={el => { mediaRef.current = el; }}
          className="alertVideo"
          src={item.media.src}
          playsInline
        />
      )}
      {item.media?.kind === 'audio' && (
        <audio ref={el => { mediaRef.current = el; }} src={item.media.src} />
      )}
      <div className="alertText">{item.text}</div>
    </div>
  );
}
