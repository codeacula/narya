import React, { useState, useEffect } from 'react';
import { getViewers } from '../services/dashboard';
import { Spotlight } from '../ui/panels';
import type { PanelCtx } from '../ui/panels';
import type { Viewer } from '../types';

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
    openViewerPopout: () => {}, // no-op in viewer window
  };

  return (
    <div style={{ padding: '12px', background: 'var(--bg-0)', minHeight: '100vh' }}>
      <Spotlight ctx={ctx} login={login} />
    </div>
  );
}
