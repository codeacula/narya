import { EmptyState } from '../emptyState';
import { FEED_EMPTY_ACTION_LABEL, type FeedEmpty, type FeedEmptyAction } from './feedEmpty';

/** Draws a `chatEmpty` / `eventFeedEmpty` reason, wiring each offered action. */
export function FeedEmptyState({
  empty,
  handlers,
}: {
  empty: FeedEmpty;
  handlers: Partial<Record<FeedEmptyAction, () => void>>;
}) {
  const buttons = empty.actions.filter(action => handlers[action]);
  return (
    <EmptyState
      title={empty.title}
      action={buttons.length > 0 ? (
        <div className="feed-empty-actions">
          {buttons.map(action => (
            <button key={action} className="modbtn" type="button" onClick={handlers[action]}>
              {FEED_EMPTY_ACTION_LABEL[action]}
            </button>
          ))}
        </div>
      ) : undefined}
    >
      {empty.sub}
    </EmptyState>
  );
}
