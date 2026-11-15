import React from 'react';
import type { PinnedCard } from '../shared/api';
import { errorMessage } from './errors';
import { useLiveValue, useLiveValueState } from './liveValue';
import {
  clearPinnedCard,
  getPinnedCard,
  pinTopic,
} from './services/dashboard';

/** REST seed + live `overlay:pinned-card` (null when cleared); shared by the overlay and the controls. */
export function usePinnedCard(): [PinnedCard | null, React.Dispatch<React.SetStateAction<PinnedCard | null>>] {
  return useLiveValue<PinnedCard | null>(getPinnedCard, 'overlay:pinned-card', null);
}

/**
 * The operator's side: the live card plus writes that report a failure through
 * `onError` instead of throwing. Each write's response is applied locally as well, so a
 * missed socket event cannot leave the controls showing a card that is gone.
 *
 * `status`/`stale`/`retry` say whether `card` is known (useLiveValueState). Until it
 * is, `card` is the null fallback, which must not read as "nothing pinned"
 * (controlFaces.ts): a card may be on stream.
 */
export function usePinnedCardControls(onError: (message: string) => void) {
  const { value: card, setValue: setCard, status, stale, retry } = useLiveValueState<PinnedCard | null>(
    getPinnedCard,
    'overlay:pinned-card',
    null,
  );
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback((write: () => Promise<PinnedCard | null>, fallback: string) => {
    setBusy(true);
    return write()
      .then((next) => { setCard(next); return true; })
      .catch((caught: unknown) => { onError(errorMessage(caught, fallback)); return false; })
      .finally(() => setBusy(false));
  }, [onError, setCard]);

  return {
    card,
    status,
    stale,
    retry,
    busy,
    pinTopic: (text: string) => run(() => pinTopic(text), 'Could not pin the topic'),
    clear: () => run(() => clearPinnedCard(), 'Could not clear the pinned card'),
  };
}


/**
 * The card itself. Always mounted and faded by class, so a card appearing or clearing
 * eases rather than pops; the last card's content is kept while it fades out so the
 * text does not vanish a frame before the box does.
 */
export function PinnedCardView({ card }: { card: PinnedCard | null }) {
  const last = React.useRef<PinnedCard | null>(null);
  if (card) last.current = card;
  const shown = card ?? last.current;

  return (
    <aside className={`pinned-card${card ? ' is-visible' : ''}`} aria-hidden={!card} aria-label="Pinned card">
      {shown ? (
        <>
          <span className={`pinned-card-eyebrow${shown.kind === 'topic' ? ' is-topic' : ''}`}>
            {shown.kind === 'question' ? `${shown.name} asks` : 'topic'}
          </span>
          <span className="pinned-card-text">{shown.text}</span>
        </>
      ) : null}
    </aside>
  );
}
