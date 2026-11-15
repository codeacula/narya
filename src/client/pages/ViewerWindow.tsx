import { useState, useEffect } from 'react';
import { getViewers, updateViewerProfile } from '../services/dashboard';
import { Spotlight } from '../ui/panels';
import type { PanelCtx } from '../ui/panels';
import type { Viewer } from '../../shared/api';
import { pathForViewer } from '../routing';
import { EmptyState } from '../ui/emptyState';
import { Icon } from '../ui/icons';

export function ViewerWindowPage() {
  const params = new URLSearchParams(window.location.search);
  const login = params.get('login');
  const [viewers, setViewers] = useState<Record<string, Viewer>>({});

  useEffect(() => {
    getViewers().then(setViewers);
  }, []);

  if (!login) {
    return (
      <div className="viewer-window">
        <EmptyState title="No viewer selected">Open a viewer from the dashboard or the roster to see them here.</EmptyState>
      </div>
    );
  }

  const ctx: PanelCtx = {
    viewers,
    chat: [],
    events: [],
    channel: '',
    currentSessionId: null,
    openViewerPopout: () => {},
    updateViewerProfile: async (profileLogin, profile) => {
      const updated = await updateViewerProfile(profileLogin, profile);
      setViewers(current => {
        const key = profileLogin.toLowerCase();
        const viewer = current[key];
        if (!viewer) return current;
        return {
          ...current,
          [key]: {
            ...viewer,
            ...updated,
          },
        };
      });
      return updated;
    },
    loadOlderChat: async () => false,
  };

  return (
    <div className="viewer-window">
      <div className="viewer-window-bar">
        <a
          className="modbtn viewer-window-open"
          href={pathForViewer(login)}
          target="_blank"
          rel="noreferrer"
        >
          <span>Open full page</span>
          <Icon name="popout" size={13} aria-hidden="true" focusable="false" />
        </a>
      </div>
      <Spotlight ctx={ctx} login={login} />
    </div>
  );
}
