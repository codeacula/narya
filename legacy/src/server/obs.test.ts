import { expect, test } from 'bun:test';
import { orderedSceneNames } from './obs';

test('orderedSceneNames lists scenes top-to-bottom by descending sceneIndex', () => {
  // OBS delivers scenes bottom-to-top: the top UI scene has the highest index.
  const scenes = [
    { sceneName: 'Scene - Ending', sceneIndex: 0 },
    { sceneName: 'Scene - Gaming', sceneIndex: 1 },
    { sceneName: 'Scene - Starting', sceneIndex: 2 },
  ];
  expect(orderedSceneNames(scenes)).toEqual([
    'Scene - Starting',
    'Scene - Gaming',
    'Scene - Ending',
  ]);
});

test('orderedSceneNames drops entries without a name and tolerates no input', () => {
  expect(orderedSceneNames([{ sceneIndex: 0 }, { sceneName: 'Main', sceneIndex: 1 }])).toEqual(['Main']);
  expect(orderedSceneNames(undefined)).toEqual([]);
});
