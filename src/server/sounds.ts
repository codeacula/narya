import type { SoundPlayback } from '../shared/api';
import { config } from './config';
import { broadcast } from './realtime';

export function triggerQuackSound(): SoundPlayback {
  const src = config.quackSounds[Math.floor(Math.random() * config.quackSounds.length)];
  const payload = {
    id: crypto.randomUUID(),
    src,
    volume: config.quackVolume,
  };
  broadcast('sound:play', payload);
  return payload;
}
