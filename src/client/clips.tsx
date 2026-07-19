import React from 'react';
import type { ClipButton, MediaPlayback } from '../shared/api';
import { advanceHead, enqueueUnique } from './queue';
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

/** Metadata should always be positive, but a safe ratio keeps malformed videos visible. */
export function videoAspectRatio(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 16 / 9;
  return width / height;
}

type VideoLayout = {
  itemId: string;
  aspectRatio: number;
};

type ClipFrameStyle = React.CSSProperties & {
  '--clip-aspect': number;
  '--clip-width-from-height': string;
};

/** Append unless the id is already queued — a replayed socket event must not double-play. */
export function enqueue(queue: MediaPlayback[], item: MediaPlayback): MediaPlayback[] {
  // The viewer already spent their points and EventSub recorded the redeem, so
  // a silent drop looks like a broken clip. Say so where the operator can see it.
  return enqueueUnique(
    queue,
    item,
    MAX_QUEUE,
    `Clips: queue is full (${MAX_QUEUE}), dropping ${item.src}${item.actor ? ` from ${item.actor}` : ''}.`,
  );
}

/**
 * Drop the head, but only if `id` still names it. A failing file can both reject
 * play() and fire the element's error event; without this check the two
 * completions would drop two items and swallow the redeem behind the bad one.
 */
export function advance(queue: MediaPlayback[], id: string): MediaPlayback[] {
  return advanceHead(queue, id);
}

/**
 * Audio and video queue independently, and both drain at once.
 *
 * Only video is visually exclusive — two clips cannot share the screen, so they
 * must serialize. Sound has no such constraint, and one shared queue would make an
 * alert fanfare wait out whatever clip happened to be playing. Alerts used to have
 * their own overlay and never queued behind redeems; keeping the two lanes separate
 * preserves that now that both arrive on `media:play`.
 *
 * Each lane is still one-at-a-time, so a redeem storm cannot stack ten sounds on
 * top of each other.
 */
export function useMediaQueue() {
  const [audio, setAudio] = React.useState<MediaPlayback[]>([]);
  const [video, setVideo] = React.useState<MediaPlayback[]>([]);

  useSocket<MediaPlayback>('media:play', React.useCallback((item) => {
    const setLane = item.kind === 'audio' ? setAudio : setVideo;
    setLane(current => enqueue(current, item));
  }, []));

  // The id alone identifies the lane's head, so a completion can be applied to both
  // without a kind: only the lane actually holding that id advances.
  const onFinished = React.useCallback((id: string) => {
    setAudio(current => advance(current, id));
    setVideo(current => advance(current, id));
  }, []);

  return {
    current: video[0] ?? null,
    currentAudio: audio[0] ?? null,
    depth: audio.length + video.length,
    onFinished,
  };
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
  const [videoLayout, setVideoLayout] = React.useState<VideoLayout | null>(null);

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

  const aspectRatio = videoLayout?.itemId === item.id ? videoLayout.aspectRatio : null;
  const frameStyle: ClipFrameStyle | undefined = aspectRatio === null ? undefined : {
    '--clip-aspect': aspectRatio,
    '--clip-width-from-height': `${aspectRatio * 82}vh`,
  };

  // The glow and highlight are pseudo-elements, which <video> cannot carry, so
  // the clip plays inside a wrapper that draws them around it.
  return (
    <div
      className={`clip-frame${aspectRatio === null ? '' : ' clip-frame-ready'}`}
      key={item.id}
      style={frameStyle}
    >
      <video
        ref={el => { mediaRef.current = el; }}
        className="clip-video"
        src={item.src}
        playsInline
        onLoadedMetadata={event => {
          setVideoLayout({
            itemId: item.id,
            aspectRatio: videoAspectRatio(event.currentTarget.videoWidth, event.currentTarget.videoHeight),
          });
        }}
        onEnded={finish}
        onError={finish}
      />
    </div>
  );
}
