import * as React from 'react';
import { ControlsPanel, Panel } from 'streamer-tools';
import { OBS_SCENES, SCENE_PREFIX, STATUS } from './_fixtures';

const Cockpit = ({ children }: { children: React.ReactNode }) => (
  <div className="cockpit" style={{ padding: 16, height: 'auto' }}>{children}</div>
);

const base = {
  scenes: OBS_SCENES,
  scenePrefix: SCENE_PREFIX,
  onSwitchScene: () => undefined,
  sceneSwitching: false,
};

// Controls is a dashboard module body — the Panel that hosts it is the real
// composition, so the scene grid reads at its true width.
export const InPanel = () => (
  <Cockpit>
    <Panel id="controls" title="Controls" popped={false} onPop={() => undefined} dot={false}>
      <ControlsPanel {...base} status={STATUS} currentScene="Scene - 02 - Desktop" />
    </Panel>
  </Cockpit>
);

// Mid-switch: every button is inert until OBS confirms the transition, so a
// double-tap can't queue two scene changes.
export const Switching = () => (
  <Cockpit>
    <Panel id="controls" title="Controls" popped={false} onPop={() => undefined} dot={false}>
      <ControlsPanel {...base} status={STATUS} currentScene="Scene - 02 - Desktop" sceneSwitching />
    </Panel>
  </Cockpit>
);

// OBS down: the scene section unmounts entirely and only the persisted media-mute
// switch remains. This is why the overlay-bounds toggle was moved to the nav bar.
export const ObsDisconnected = () => (
  <Cockpit>
    <Panel id="controls" title="Controls" popped={false} onPop={() => undefined} dot={false}>
      <ControlsPanel
        {...base}
        status={{ ...STATUS, obsConnected: false }}
        currentScene=""
      />
    </Panel>
  </Cockpit>
);

// An empty prefix means "no naming convention" — every OBS scene becomes a
// switch target and the full name is the label.
export const NoScenePrefix = () => (
  <Cockpit>
    <Panel id="controls" title="Controls" popped={false} onPop={() => undefined} dot={false}>
      <ControlsPanel
        {...base}
        scenePrefix=""
        status={STATUS}
        currentScene="Nested - Alerts"
      />
    </Panel>
  </Cockpit>
);
