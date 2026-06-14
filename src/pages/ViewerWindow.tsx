import React from 'react';
import { getViewers } from '../services/dashboard';
import { Spotlight } from '../ui/panels';
import type { PanelCtx } from '../ui/panels';

export function ViewerWindowPage() {
  const params = new URLSearchParams(window.location.search);
  const login = params.get('login');

  if (!login) {
    return <div style={{ padding: '20px', color: '#fff' }}>No viewer selected</div>;
  }

  const viewers = getViewers();
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
