import React from 'react';
import {
  banViewer,
  sendViewerShoutout,
  sendViewerWhisper,
  timeoutViewer,
} from '../../services/dashboard';
import type { ViewerProfileUpdate } from '../../../shared/api';
import { renderContent, useEmotes } from '../../chat';
import { errorMessage } from '../../errors';
import { DEFAULT_TIMEOUT_MINUTES, timeoutSeconds } from '../../timeoutDuration';
import type { PanelCtx } from './context';
import { ViewerActionModal, ViewerProfileModal, type ViewerActionKind } from './viewerModals';

export function Spotlight({
  ctx,
  login,
  hideIdentity,
}: {
  ctx: PanelCtx;
  login?: string;
  /** Drop the avatar/name/roles block. The Viewers page's detail pane draws its own,
   *  larger one with the role controls in it; two of them read as a rendering bug. */
  hideIdentity?: boolean;
}) {
  const normalizedLogin = login?.toLowerCase();
  const viewer = normalizedLogin ? ctx.viewers[normalizedLogin] : null;
  const emoteMap = useEmotes();
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [actionOpen, setActionOpen] = React.useState<ViewerActionKind | null>(null);
  const [busyAction, setBusyAction] = React.useState<ViewerActionKind | 'shoutout' | null>(null);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  if (!viewer) {
    return (
      <div className="empty-state">
        <div className="es-orb" />
        <div className="es-title">No one in focus</div>
        <div className="es-sub">
          Click any name in chat to pull up their history, roles, and recent messages here.
        </div>
      </div>
    );
  }

  const hasProfile = Boolean(viewer.realName || viewer.tags.length > 0 || viewer.note);
  const saveProfile = async (profile: ViewerProfileUpdate) => {
    await ctx.updateViewerProfile(viewer.login, profile);
  };
  const openAction = (action: ViewerActionKind) => {
    setActionOpen(action);
    setActionError(null);
    setActionMessage(null);
  };
  const handleShoutout = () => {
    setBusyAction('shoutout');
    setActionError(null);
    setActionMessage(null);
    void sendViewerShoutout(viewer.login)
      .then(result => setActionMessage(result.message))
      .catch(error => setActionError(errorMessage(error, 'Shoutout failed')))
      .finally(() => setBusyAction(null));
  };
  const handleActionSubmit = (payload: { message?: string; durationMinutes?: number; reason?: string }) => {
    if (!actionOpen) return;
    const action = actionOpen;
    setBusyAction(action);
    setActionError(null);
    setActionMessage(null);

    const request = action === 'whisper'
      ? sendViewerWhisper(viewer.login, payload.message ?? '')
      : action === 'timeout'
        ? timeoutViewer(
            viewer.login,
            timeoutSeconds(payload.durationMinutes ?? DEFAULT_TIMEOUT_MINUTES),
            payload.reason ?? '',
          )
        : banViewer(viewer.login, payload.reason ?? '');

    void request
      .then(result => {
        setActionMessage(result.message);
        setActionOpen(null);
      })
      .catch(error => setActionError(errorMessage(error, 'Viewer action failed')))
      .finally(() => setBusyAction(null));
  };

  return (
    <>
      <div className="spot">
        {!hideIdentity && (
          <div className="spot-head">
            <div className="spot-avatar" style={{ background: viewer.color }}>
              {viewer.display.charAt(0).toUpperCase()}
            </div>
            <div className="spot-id">
              <div className="spot-name" style={{ color: viewer.color }}>{viewer.display}</div>
              {viewer.realName && <div className="spot-real-name">{viewer.realName}</div>}
              <div className="spot-meta">{viewer.accountAge}</div>
              <div className="spot-roles">
                {viewer.roles.includes('mod') && <span className="rolepill mod">moderator</span>}
                {viewer.roles.includes('vip') && <span className="rolepill vip">vip</span>}
                {viewer.roles.includes('sub') && <span className="rolepill sub">subscriber</span>}
                {viewer.roles.length === 0 && (
                  <span className="rolepill" style={{ color: 'var(--fg-3)', borderColor: 'var(--border-1)' }}>
                    viewer
                  </span>
                )}
                {viewer.tags.map(tag => (
                  <span className="profile-tag" key={tag}>{tag}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="spot-stats">
          <div className="stat">
            <div className="k">Following</div><div className="v">{viewer.followed}</div>
          </div>
          <div className="stat">
            <div className="k">Subscription</div><div className="v">{viewer.subbed}</div>
          </div>
          <div className="stat">
            <div className="k">Messages</div><div className="v">{viewer.msgs.toLocaleString()} all-time</div>
          </div>
          <div className="stat">
            <div className="k">First seen</div><div className="v">{viewer.seen}</div>
          </div>
        </div>

        {viewer.note && <div className="spot-note">{viewer.note}</div>}

        {(actionMessage || (!actionOpen && actionError)) && (
          <div className={'spot-action-status' + (actionError ? ' error' : '')}>
            {actionError ?? actionMessage}
          </div>
        )}

        <div>
          <div className="spot-section-label" style={{ marginBottom: '9px' }}>Recent in chat</div>
          <div className="spot-recent">
            {viewer.recent.map((r, i) => (
              <div className={'rmsg' + (r.kind ? ' ' + r.kind : '')} key={i}>
                <span className="ago">{r.ago}</span>
                <span className="body">{renderContent(r.t, r.emotes ?? null, emoteMap)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="spot-actions">
          <button className="modbtn gold" disabled={busyAction !== null} onClick={handleShoutout}>
            {busyAction === 'shoutout' ? 'sending...' : 'shout out'}
          </button>
          <button className="modbtn" disabled={busyAction !== null} onClick={() => openAction('whisper')}>whisper</button>
          <button className="modbtn" onClick={() => setProfileOpen(true)}>
            {hasProfile ? 'edit profile' : 'add note'}
          </button>
          <button className="modbtn" disabled={busyAction !== null} onClick={() => openAction('timeout')}>timeout</button>
          <button className="modbtn danger" disabled={busyAction !== null} onClick={() => openAction('ban')}>ban</button>
        </div>
      </div>

      {profileOpen && (
        <ViewerProfileModal
          viewer={viewer}
          onSave={saveProfile}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {actionOpen && (
        <ViewerActionModal
          viewer={viewer}
          action={actionOpen}
          busy={busyAction === actionOpen}
          error={actionError}
          onSubmit={handleActionSubmit}
          onClose={() => {
            setActionOpen(null);
            setActionError(null);
          }}
        />
      )}
    </>
  );
}
