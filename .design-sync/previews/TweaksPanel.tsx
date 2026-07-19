import * as React from 'react';
import { TweaksPanel, TweakSection } from 'streamer-tools';

// `.twk-panel` is `position: fixed`, so it would otherwise escape the preview
// card and pin to the capture viewport. A `transform` on the wrapper makes it
// the containing block, which frames the panel against a dashboard-sized
// surface without touching the component's own positioning.
const Cockpit = ({ children, h = 300 }: { children: React.ReactNode; h?: number }) => (
  <div
    className="cockpit"
    style={{
      position: 'relative',
      transform: 'translateZ(0)',
      width: 440,
      height: h,
      padding: 0,
      border: '1px solid var(--border-1)',
      borderRadius: 'var(--radius-3)',
      overflow: 'hidden',
    }}
  >
    {children}
  </div>
);

// The dashboard's own composition (Dashboard.tsx): a section label, the live
// connection readout, then the overlay-bounds toggle.
export const Display = () => (
  <Cockpit>
    <TweaksPanel title="Display" open onClose={() => undefined}>
      <TweakSection label="Live Data" />
      <div className="live-data-list">
        <div><span>Channel</span><b>codeacula</b></div>
        <div><span>Chat</span><b>open</b></div>
        <div><span>EventSub</span><b>open</b></div>
        <div><span>OBS</span><b>connected</b></div>
      </div>
      <TweakSection label="Overlays" />
      <div className="twk-overlay-bounds">
        <label className="twk-toggle">
          <input type="checkbox" readOnly checked={false} />
          <span>Show overlay bounds</span>
        </label>
      </div>
    </TweaksPanel>
  </Cockpit>
);

// Bounds on: the warning is deliberately loud because the flag is in memory
// only and nothing else reminds the operator before they go live.
export const OverlayBoundsOn = () => (
  <Cockpit h={350}>
    <TweaksPanel title="Display" open onClose={() => undefined}>
      <TweakSection label="Live Data" />
      <div className="live-data-list">
        <div><span>Channel</span><b>codeacula</b></div>
        <div><span>Chat</span><b>open</b></div>
        <div><span>EventSub</span><b>open</b></div>
        <div><span>OBS</span><b>connected</b></div>
      </div>
      <TweakSection label="Overlays" />
      <div className="twk-overlay-bounds">
        <label className="twk-toggle">
          <input type="checkbox" readOnly checked />
          <span>Show overlay bounds</span>
        </label>
        <p className="twk-warn" role="status">
          Outlines are visible in every overlay source — turn this off before going live.
        </p>
      </div>
    </TweaksPanel>
  </Cockpit>
);

// Services down: the same panel is the operator's first stop when the cockpit
// looks wrong, so a degraded readout is a first-class state for it.
export const Disconnected = () => (
  <Cockpit>
    <TweaksPanel title="Display" open onClose={() => undefined}>
      <TweakSection label="Live Data" />
      <div className="live-data-list">
        <div><span>Channel</span><b>codeacula</b></div>
        <div><span>Chat</span><b>connecting</b></div>
        <div><span>EventSub</span><b>closed</b></div>
        <div><span>OBS</span><b>unavailable</b></div>
      </div>
      <TweakSection label="Overlays" />
      <div className="twk-overlay-bounds">
        <label className="twk-toggle">
          <input type="checkbox" readOnly checked={false} disabled />
          <span>Show overlay bounds</span>
        </label>
      </div>
    </TweaksPanel>
  </Cockpit>
);

// `title` is a prop, not a constant — the panel is reusable chrome for any
// floating group of controls.
export const CustomTitle = () => (
  <Cockpit h={230}>
    <TweaksPanel title="Overlay Bounds" open onClose={() => undefined}>
      <TweakSection label="Sources" />
      <div className="twk-overlay-bounds">
        <label className="twk-toggle">
          <input type="checkbox" readOnly checked />
          <span>Show overlay bounds</span>
        </label>
        <p className="twk-warn" role="status">
          Outlines are visible in every overlay source — turn this off before going live.
        </p>
      </div>
    </TweaksPanel>
  </Cockpit>
);
