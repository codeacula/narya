import { HoldingChat } from './holdingScene';
import { usePinnedCard } from './pinnedCard';

/** Five rows, as in mockups/Chatting.html. */
const CHAT_ROWS = 5;

/**
 * The right-hand column of Just chatting (mockups/Chatting.html): what Code is talking
 * about, a gold rule, then chat. The webcam fills the left of the scene and is an OBS
 * source, so the rest of this 1920x1080 browser source stays transparent.
 *
 * The topic is the pinned card, not a second store: it is the one slot Code already
 * sets from the dashboard and tablet ("topic" or a pinned viewer question), and on this
 * scene it is drawn as the column's headline instead of as a floating card. With
 * nothing pinned the headline and rule are left out and chat holds the column alone.
 *
 * Chat never expires here (HoldingChat): Just chatting is on screen for long stretches,
 * and a column that empties between messages looks broken.
 */
export function ChattingColumn() {
  const [card] = usePinnedCard();

  return (
    <aside className="chatting-column" aria-label="Just chatting column">
      {card ? (
        <div className="chatting-topic">
          <span className={`chatting-eyebrow${card.kind === 'question' ? ' is-question' : ''}`}>
            {card.kind === 'question' ? `${card.name} asks` : 'talking about'}
          </span>
          <span className="chatting-topic-text">{card.text}</span>
          <div className="chatting-rule" aria-hidden="true" />
        </div>
      ) : null}
      <HoldingChat rows={CHAT_ROWS} className="chatting-chat" />
    </aside>
  );
}
