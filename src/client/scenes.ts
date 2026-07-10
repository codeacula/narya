// Shared client helpers for OBS scene selection. Scenes the operator switches
// between are conventionally prefixed with "Scene - "; when any scene matches
// that prefix we show only those, otherwise we fall back to every scene so the
// controls still work with a differently-named setup.
//
// Buttons are ordered to match the OBS scene list (see orderedSceneNames in
// src/server/obs.ts). An optional numeric prefix after "Scene - " (e.g.
// "Scene - 01 - Starting") lets the operator force an explicit order in OBS
// while keeping a clean button label ("Starting").

const SWITCHABLE_SCENE_PREFIX = 'Scene -';
const ORDER_PREFIX = /^\d+\s*[-.)]\s*/;

export function switchableScenes(scenes: string[]): string[] {
  const prefixed = scenes.filter(scene => scene.startsWith(SWITCHABLE_SCENE_PREFIX));
  return prefixed.length > 0 ? prefixed : scenes;
}

export function sceneLabel(name: string): string {
  const withoutPrefix = name.startsWith('Scene - ') ? name.slice('Scene - '.length) : name;
  return withoutPrefix.replace(ORDER_PREFIX, '');
}
