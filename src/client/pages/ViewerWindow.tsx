import React, { useState, useEffect } from 'react';
import { getViewers, updateViewerProfile } from '../services/dashboard';
import { Spotlight } from '../ui/panels';
import type { PanelCtx } from '../ui/panels';
import type { Viewer } from '../../shared/api';

export function ViewerWindowPage() {
  const params = new URLSearchParams(window.location.search);
  const login = params.get('login');
  const [viewers, setViewers] = useState<Record<string, Viewer>>({});

  useEffect(() => {
    getViewers().then(setViewers);
  }, []);

  if (!login) {
    return <div style={{ padding: '20px', color: '#fff' }}>No viewer selected</div>;
  }

  const ctx: PanelCtx = {
    viewers,
    chat: [],
    events: [],
    channel: '',
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
    <div style={{ padding: '12px', background: 'var(--bg-0)', minHeight: '100vh' }}>
      <Spotlight ctx={ctx} login={login} />
    </div>
  );
}
