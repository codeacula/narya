// Shared client helpers for OBS scene selection. Scenes the operator switches
// between are marked by a configured prefix (Settings → Connections; "Scene - " by
// default); when any scene matches it we show only those, otherwise we fall back to
// every scene so the controls still work with a differently-named setup. An empty
// prefix means "no convention" — every scene is a switch target.
//
// The prefix travels on ObsStatus.scenePrefix rather than being a constant here,
// because it is the operator's naming convention, not the app's.
//
// Buttons are ordered to match the OBS scene list (see orderedSceneNames in
// src/server/obs.ts). An optional numeric prefix after the scene prefix (e.g.
// "Scene - 01 - Starting") lets the operator force an explicit order in OBS while
// keeping a clean button label ("Starting").

const ORDER_PREFIX = /^\d+\s*[-.)]\s*/;

export function switchableScenes(scenes: string[], prefix: string): string[] {
  if (!prefix) return scenes;
  const prefixed = scenes.filter(scene => scene.startsWith(prefix));
  return prefixed.length > 0 ? prefixed : scenes;
}

export function sceneLabel(name: string, prefix: string): string {
  const withoutPrefix = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return withoutPrefix.replace(ORDER_PREFIX, '') || name;
}
