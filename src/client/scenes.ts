// Shared client helpers for OBS scene selection. Scenes the operator switches
// between are conventionally prefixed with "Scene - "; when any scene matches
// that prefix we show only those, otherwise we fall back to every scene so the
// controls still work with a differently-named setup.

const SWITCHABLE_SCENE_PREFIX = 'Scene -';

export function switchableScenes(scenes: string[]): string[] {
  const prefixed = scenes.filter(scene => scene.startsWith(SWITCHABLE_SCENE_PREFIX));
  return prefixed.length > 0 ? prefixed : scenes;
}

export function sceneLabel(name: string): string {
  return name.startsWith('Scene - ') ? name.slice('Scene - '.length) : name;
}
