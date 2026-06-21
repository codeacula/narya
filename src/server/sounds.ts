import type { SoundButton, SoundPlayback } from '../shared/api';
import { config } from './config';
import { db } from './db';
import { broadcast } from './realtime';

const defaultSoundButtons = config.quackSounds.map((filename, index) => ({
  id: `quack-${index + 1}`,
  label: `Quack ${index + 1}`,
  filename,
}));

const countSoundButtons = db.prepare('select count(*) as count from sound_buttons');
const insertSoundButton = db.prepare(`
  insert or ignore into sound_buttons (id, label, filename)
  values (?, ?, ?)
`);
const listSoundButtons = db.prepare(`
  select id, label, filename
  from sound_buttons
  order by label collate nocase
`);
const getSoundButton = db.prepare(`
  select id, label, filename
  from sound_buttons
  where id = ?
`);

function seedSoundButtonsIfEmpty() {
  const row = countSoundButtons.get() as { count: number };
  if (row.count > 0) return;
  for (const sound of defaultSoundButtons) {
    insertSoundButton.run(sound.id, sound.label, sound.filename);
  }
}

export function getSoundButtons(): SoundButton[] {
  seedSoundButtonsIfEmpty();
  return listSoundButtons.all() as SoundButton[];
}

function playSound(src: string, volume = config.quackVolume): SoundPlayback {
  const payload = {
    id: crypto.randomUUID(),
    src,
    volume,
  };
  broadcast('sound:play', payload);
  return payload;
}

export function triggerQuackSound(): SoundPlayback {
  const src = config.quackSounds[Math.floor(Math.random() * config.quackSounds.length)];
  return playSound(src);
}

export function triggerSoundButton(id: string): SoundPlayback | null {
  seedSoundButtonsIfEmpty();
  const sound = getSoundButton.get(id) as SoundButton | null;
  if (!sound) return null;
  return playSound(sound.filename);
}
