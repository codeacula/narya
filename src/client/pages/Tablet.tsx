import React from 'react';
import { ControlSurface } from '../legacy';

export function TabletPage() {
  return (
    <main className="tabletShell">
      <header>
        <h1>Stream Controls</h1>
        <a href="/">Dashboard</a>
      </header>
      <ControlSurface tablet />
    </main>
  );
}
