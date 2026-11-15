import React from 'react';
import { Icon } from '../icons';
import { Modal, ModalTitle } from '../modal';
import { useDirtyGuard } from '../dirtyGuard';
import { draftsDiffer } from '../dirtyGuardLogic';
import type { Viewer, ViewerProfileUpdate } from '../../../shared/api';
import { addProfileTag, MAX_VIEWER_TAGS, normalizeProfileTag } from '../../../shared/viewerTags';
import { errorMessage } from '../../errors';
import {
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  TIMEOUT_PRESETS,
  isValidTimeoutMinutes,
  resolveTimeoutMinutes,
  timeoutLabel,
} from '../../timeoutDuration';

export type ViewerActionKind = 'whisper' | 'timeout' | 'ban';

export function ViewerProfileModal({
  viewer,
  onSave,
  onClose,
}: {
  viewer: Viewer;
  onSave: (profile: ViewerProfileUpdate) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = React.useState<ViewerProfileUpdate>({
    realName: viewer.realName,
    tags: viewer.tags,
    note: viewer.note,
  });
  const [tagInput, setTagInput] = React.useState('');
  const realNameRef = React.useRef<HTMLInputElement>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setForm({
      realName: viewer.realName,
      tags: viewer.tags,
      note: viewer.note,
    });
    setTagInput('');
    setError(null);
  }, [viewer.login, viewer.note, viewer.realName, viewer.tags]);

  // A typed-but-not-added tag is saved too (see handleSubmit), so it counts as an edit.
  const dirty = tagInput.trim() !== ''
    || draftsDiffer(form, { realName: viewer.realName, tags: viewer.tags, note: viewer.note });
  const { discardThen } = useDirtyGuard(dirty, `the profile for @${viewer.login}`);
  const requestClose = React.useCallback(() => discardThen(onClose), [discardThen, onClose]);

  const addTag = React.useCallback((value: string) => {
    setForm(current => ({ ...current, tags: addProfileTag(current.tags, value) }));
    setTagInput('');
  }, []);

  const removeTag = React.useCallback((tag: string) => {
    setForm(current => ({ ...current, tags: current.tags.filter(item => item !== tag) }));
  }, []);

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);
    const tags = tagInput ? addProfileTag(form.tags, tagInput) : form.tags;
    void onSave({
      realName: form.realName.trim(),
      tags: tags.map(normalizeProfileTag).filter(Boolean),
      note: form.note.trim(),
    })
      .then(onClose)
      .catch(saveError => {
        setError(errorMessage(saveError, 'Could not save viewer profile'));
      })
      .finally(() => setSaving(false));
  }, [form, onClose, onSave, saving, tagInput]);

  return (
    <Modal as="form" className="stream-info-modal viewer-profile-modal" onSubmit={handleSubmit} onClose={requestClose} initialFocusRef={realNameRef}>
      <div className="modal-head">
        <div>
          <ModalTitle>Viewer Profile</ModalTitle>
          <div className="viewer-profile-login">@{viewer.login}</div>
        </div>
        <button className="icon-btn" type="button" title="Close" aria-label="Close" onClick={requestClose}>
          <Icon name="x" />
        </button>
      </div>

      <label className="field">
        <span>Real name</span>
        <input
          ref={realNameRef}
          value={form.realName}
          maxLength={120}
          disabled={saving}
          onChange={event => setForm(current => ({ ...current, realName: event.target.value }))}
        />
        <small>{form.realName.length}/120</small>
      </label>

      <div className="field">
        <span>Tags</span>
        <div className="tag-chip-list">
          {form.tags.map(tag => (
            <span className="tag-chip" key={tag}>
              {tag}
              <button type="button" title={`Remove ${tag}`} disabled={saving} onClick={() => removeTag(tag)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
        <input
          aria-label="Add viewer tag"
          value={tagInput}
          maxLength={32}
          disabled={saving || form.tags.length >= MAX_VIEWER_TAGS}
          placeholder={form.tags.length >= MAX_VIEWER_TAGS ? 'Tag limit reached' : 'Type a tag and press Enter'}
          onChange={event => setTagInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              addTag(tagInput);
            }
          }}
        />
        <small>{form.tags.length}/12</small>
      </div>

      <label className="field">
        <span>Notes</span>
        <textarea
          value={form.note}
          maxLength={1000}
          rows={7}
          disabled={saving}
          onChange={event => setForm(current => ({ ...current, note: event.target.value }))}
        />
        <small>{form.note.length}/1000</small>
      </label>

      {error && <div className="modal-status error">{error}</div>}

      <div className="modal-actions">
        <button className="modbtn" type="button" onClick={requestClose} disabled={saving}>Cancel</button>
        <button className="modbtn gold" type="submit" disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

export function ViewerActionModal({
  viewer,
  action,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  viewer: Viewer;
  action: ViewerActionKind;
  busy: boolean;
  error: string | null;
  onSubmit: (payload: { message?: string; durationMinutes?: number; reason?: string }) => void;
  onClose: () => void;
}) {
  const [message, setMessage] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [presetMinutes, setPresetMinutes] = React.useState(DEFAULT_TIMEOUT_MINUTES);
  const [customMinutes, setCustomMinutes] = React.useState('');
  // Whisper's message or the timeout/ban reason: whichever box the action shows.
  const firstFieldRef = React.useRef<HTMLTextAreaElement>(null);
  const isWhisper = action === 'whisper';
  const isTimeout = action === 'timeout';
  const title = isWhisper ? 'Whisper' : isTimeout ? 'Timeout Viewer' : 'Ban Viewer';

  // Derived, not a third piece of state: the chips and the custom field are two
  // views of one duration, and holding it separately is how they drift apart.
  const usingCustom = customMinutes.trim() !== '';
  const durationMinutes = resolveTimeoutMinutes(presetMinutes, customMinutes);
  const durationValid = isValidTimeoutMinutes(durationMinutes);

  const submitLabel = busy
    ? 'Working...'
    : isWhisper
      ? 'Send whisper'
      // The committed duration rides on the button itself, so the last thing the
      // operator reads before clicking is what they are about to hand out.
      : isTimeout
        ? `Timeout · ${timeoutLabel(durationMinutes)}`
        : 'Ban';

  // The duration chips are one tap to set again; typed words are what would be lost.
  const dirty = (isWhisper ? message : reason).trim() !== '';
  const { discardThen } = useDirtyGuard(
    dirty,
    isWhisper ? `the whisper to @${viewer.login}` : `the ${isTimeout ? 'timeout' : 'ban'} reason for @${viewer.login}`,
  );
  const requestClose = React.useCallback(() => discardThen(onClose), [discardThen, onClose]);

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({
      message,
      durationMinutes,
      reason,
    });
  }, [durationMinutes, message, onSubmit, reason]);

  return (
    <Modal as="form" className="stream-info-modal viewer-action-modal" onSubmit={handleSubmit} onClose={requestClose} initialFocusRef={firstFieldRef}>
      <div className="modal-head">
        <div>
          <ModalTitle>{title}</ModalTitle>
          <div className="viewer-profile-login">@{viewer.login}</div>
        </div>
        <button className="icon-btn" type="button" title="Close" aria-label="Close" onClick={requestClose}>
          <Icon name="x" />
        </button>
      </div>

      {isWhisper ? (
        <label className="field">
          <span>Message</span>
          <textarea
            ref={firstFieldRef}
            value={message}
            maxLength={500}
            rows={5}
            disabled={busy}
            onChange={event => setMessage(event.target.value)}
          />
          <small>{message.length}/500</small>
        </label>
      ) : (
        <>
          {isTimeout && (
            <div className="field">
              <span>Duration</span>
              <div className="timeout-presets" role="group" aria-label="Timeout duration">
                {TIMEOUT_PRESETS.map(preset => {
                  const selected = !usingCustom && preset.minutes === presetMinutes;
                  return (
                    <button
                      key={preset.minutes}
                      type="button"
                      className={'timeout-preset' + (selected ? ' selected' : '')}
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => { setPresetMinutes(preset.minutes); setCustomMinutes(''); }}
                    >
                      {preset.label}
                    </button>
                  );
                })}
                <input
                  className="timeout-custom"
                  type="number"
                  min={1}
                  max={MAX_TIMEOUT_MINUTES}
                  placeholder="mins"
                  aria-label="Custom duration in minutes"
                  value={customMinutes}
                  disabled={busy}
                  onChange={event => setCustomMinutes(event.target.value)}
                />
              </div>
              <small className={durationValid ? undefined : 'error'}>
                {durationValid ? '1 minute to 14 days' : `Enter 1–${MAX_TIMEOUT_MINUTES} minutes`}
              </small>
            </div>
          )}
          <label className="field">
            <span>Reason</span>
            <textarea
              ref={firstFieldRef}
              value={reason}
              maxLength={500}
              rows={4}
              disabled={busy}
              onChange={event => setReason(event.target.value)}
            />
            <small>{reason.length}/500</small>
          </label>
        </>
      )}

      {error && <div className="modal-status error">{error}</div>}

      <div className="modal-actions">
        <button className="modbtn" type="button" onClick={requestClose} disabled={busy}>Cancel</button>
        <button
          className={'modbtn ' + (action === 'ban' ? 'danger' : 'gold')}
          type="submit"
          disabled={busy || (isWhisper && !message.trim()) || (isTimeout && !durationValid)}
        >
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}
