import * as React from 'react';
import { TweaksPanel, TweakSection } from 'streamer-tools';

// TweakSection is a single label div (`.twk-sect`) whose rule set only makes
// sense inside `.twk-body` — the separator, the first-child reset and the
// scale all come from the panel. It is always composed inside TweaksPanel.
//
// The panel is `position: fixed`; a `transform` on the wrapper makes this the
// containing block so the card frames it instead of the capture viewport.
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

const boundsToggle = (
  <div className="twk-overlay-bounds">
    <label className="twk-toggle">
      <input type="checkbox" readOnly checked={false} />
      <span>Show overlay bounds</span>
    </label>
  </div>
);

// The dashboard's real usage: two sections, each labelling the block below it.
export const InTweaksPanel = () => (
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
      {boundsToggle}
    </TweaksPanel>
  </Cockpit>
);

// The separator is the point of the component: `.twk-sect` draws a top rule,
// and `:first-child` suppresses it so the panel never opens with a stray line.
export const SeparatorRule = () => (
  <Cockpit h={370}>
    <TweaksPanel title="Display" open onClose={() => undefined}>
      <TweakSection label="Live Data" />
      <div className="live-data-list">
        <div><span>Channel</span><b>codeacula</b></div>
        <div><span>Uptime</span><b>4h 12m</b></div>
      </div>
      <TweakSection label="Overlays" />
      {boundsToggle}
      <TweakSection label="Playback" />
      <div className="live-data-list">
        <div><span>Music volume</span><b>45%</b></div>
        <div><span>Sound volume</span><b>70%</b></div>
      </div>
      <TweakSection label="Scenes" />
      <div className="live-data-list">
        <div><span>Prefix</span><b>Scene - </b></div>
        <div><span>Active</span><b>Starting Soon</b></div>
      </div>
    </TweaksPanel>
  </Cockpit>
);

// Labels are rendered verbatim and uppercased in CSS, so a long one wraps
// rather than truncating — worth seeing next to a short one.
export const LabelLengths = () => (
  <Cockpit h={250}>
    <TweaksPanel title="Display" open onClose={() => undefined}>
      <TweakSection label="OBS" />
      <div className="live-data-list">
        <div><span>Studio mode</span><b>off</b></div>
      </div>
      <TweakSection label="Overlay bounds and browser sources" />
      {boundsToggle}
    </TweaksPanel>
  </Cockpit>
);
