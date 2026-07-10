import React from 'react';
import type { StreamStatus } from '../shared/api';
import { useSocket } from './realtime';
import { getStreamStatus, updateStreamStatus } from './services/dashboard';

// REST seed + live `status:updated` updates. Used by the overlay widget.
export function useStreamStatus() {
  const [status, setStatus] = React.useState<StreamStatus | null>(null);

  React.useEffect(() => {
    getStreamStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useSocket<StreamStatus>(
    'status:updated',
    React.useCallback((next) => setStatus(next), []),
  );

  return status;
}

// Compact cockpit editor. External systems can also update the status via
// PUT /api/stream-status; those arrive over the socket and are reflected here
// unless the operator has an unsaved local edit in progress.
export function StreamStatusBar() {
  const [text, setText] = React.useState('');
  const [savedText, setSavedText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const textRef = React.useRef(text);
  textRef.current = text;
  const savedRef = React.useRef(savedText);
  savedRef.current = savedText;

  const applyStatus = React.useCallback((status: StreamStatus) => {
    // Follow the incoming value only when the operator hasn't started editing;
    // otherwise keep their draft but move the saved baseline behind it.
    if (textRef.current === savedRef.current) setText(status.text);
    setSavedText(status.text);
  }, []);

  React.useEffect(() => {
    getStreamStatus().then(applyStatus).catch(() => undefined);
  }, [applyStatus]);

  useSocket<StreamStatus>('status:updated', applyStatus);

  const dirty = text !== savedText;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const status = await updateStreamStatus(text);
      setSavedText(status.text);
      setText(status.text);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update stream status.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="stream-status-bar" onSubmit={submit}>
      <span className="stream-status-label">Status</span>
      <input
        className="stream-status-input"
        aria-label="Stream status line"
        value={text}
        maxLength={280}
        placeholder="Set a stream status line…"
        disabled={saving}
        onChange={event => setText(event.target.value)}
      />
      <button className="modbtn gold" type="submit" disabled={saving || !dirty}>
        {saving ? 'Saving…' : dirty ? 'Update' : 'Saved'}
      </button>
      {error ? <span className="stream-status-error" role="status">{error}</span> : null}
    </form>
  );
}
