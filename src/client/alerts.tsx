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
 * Shows one alert at a time: a text banner plus an optional sound and/or clip,
 * which play together. The alert stays until its text duration has elapsed AND
 * every attached effect has finished, so a short clip never cuts the banner off
 * early and a long clip isn't clipped. Renders nothing when idle so the browser
 * source stays fully transparent.
 *
 * Autoplay: OBS browser sources run with --autoplay-policy=no-user-gesture-required,
 * so audible playback starts on its own. A plain browser tab may reject play() until
 * the page is clicked; we treat that as effect-done rather than wedge the queue.
 */
export function AlertStage({ item, onFinished }: { item: AlertPlayback | null; onFinished: (id: string) => void }) {
  const soundRef = React.useRef<HTMLAudioElement | null>(null);
  const clipRef = React.useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => {
    if (!item) return;
    let finished = false;
    let timerDone = false;
    let soundDone = !item.sound; // no effect → nothing to wait for
    let clipDone = !item.clip;
    const finish = () => {
      if (finished) return;
      finished = true;
      onFinished(item.id);
    };
    const maybeFinish = () => {
      if (timerDone && soundDone && clipDone) finish();
    };
    const cleanups: Array<() => void> = [];
    const timer = window.setTimeout(() => { timerDone = true; maybeFinish(); }, item.durationMs);
    cleanups.push(() => window.clearTimeout(timer));

    // Start one effect element and mark it done on ended/error/play-rejection.
    const startEffect = (
      element: HTMLMediaElement | null,
      media: { src: string; volume: number } | null,
      markDone: () => void,
    ) => {
      if (!media || !element) return;
      const onDone = () => { markDone(); maybeFinish(); };
      element.volume = Math.max(0, Math.min(1, media.volume));
      element.currentTime = 0;
      element.addEventListener('ended', onDone);
      element.addEventListener('error', onDone);
      void element.play().catch((error: unknown) => {
        console.error(`Alerts: could not play ${media.src}:`, error);
        onDone();
      });
      cleanups.push(() => {
        element.removeEventListener('ended', onDone);
        element.removeEventListener('error', onDone);
      });
    };

    startEffect(soundRef.current, item.sound, () => { soundDone = true; });
    startEffect(clipRef.current, item.clip, () => { clipDone = true; });

    return () => { cleanups.forEach(fn => fn()); };
  }, [item, onFinished]);

  if (!item) return null;

  return (
    <div className={`alertCard alertCard--${item.tone}`} key={item.id}>
      {item.clip && (
        <video
          ref={el => { clipRef.current = el; }}
          className="alertVideo"
          src={item.clip.src}
          playsInline
        />
      )}
      {item.sound && (
        <audio ref={el => { soundRef.current = el; }} src={item.sound.src} />
      )}
      <div className="alertText">{item.text}</div>
    </div>
  );
}
