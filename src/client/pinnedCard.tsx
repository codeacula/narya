import React from 'react';
import type { PinnedCard } from '../shared/api';
import { errorMessage } from './errors';
import { useLiveValue } from './liveValue';
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
 */
export function usePinnedCardControls(onError: (message: string) => void) {
  const [card, setCard] = usePinnedCard();
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
    busy,
    pinTopic: (text: string) => run(() => pinTopic(text), 'Could not pin the topic'),
    clear: () => run(() => clearPinnedCard(), 'Could not clear the pinned card'),
  };
}

/** One-line readout of the current card for the operator surfaces. */
export function pinnedCardSummary(card: PinnedCard | null): string {
  if (!card) return 'nothing pinned';
  return card.kind === 'question' ? `${card.name} asks: ${card.text}` : `topic: ${card.text}`;
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
