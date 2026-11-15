import { SettingsAnnouncer } from '../pages/settings/shared';

/**
 * What went wrong with an operator control's live value: its state could not be read
 * or refreshed (`unreadable`, with a Retry, since nothing else re-asks until the socket
 * reconnects), or the operator's own write was refused (`error`, which wins). The
 * spoken half is always mounted (`SettingsAnnouncer`) so the line is announced.
 *
 * `className` adds the surface's own layout (the Display panel is not a controls row).
 */
export function ControlProblem({
  unreadable,
  error,
  onRetry,
  className = 'ctrl-inline-warning ctrl-inline-problem',
}: {
  unreadable: string | null;
  error: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  const text = error ?? unreadable;
  return (
    <>
      <SettingsAnnouncer error={text} />
      {text ? (
        <p className={className}>
          <span aria-hidden="true">{text}</span>
          {!error && unreadable && onRetry ? (
            <button className="stale-notice-retry" type="button" onClick={onRetry}>Retry</button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
