import type { SoundButton, SoundButtonUpdate, SoundPlayback } from '../shared/api';
import { appConfig } from './appConfig';
import { config } from './config';
import { db } from './db';
import { HttpRouteError } from './http';
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
const createSoundButtonRow = db.prepare(`
  insert into sound_buttons (id, label, filename)
  values (?, ?, ?)
`);
const updateSoundButtonRow = db.prepare(`
  update sound_buttons
  set label = ?, filename = ?
  where id = ?
`);
const deleteSoundButtonRow = db.prepare('delete from sound_buttons where id = ?');

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

function normalizeSoundButtonBody(body: unknown): SoundButtonUpdate {
  const value = body as Partial<SoundButtonUpdate>;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const filename = typeof value.filename === 'string' ? value.filename.trim() : '';

  if (!label) throw new HttpRouteError(400, 'Sound label is required.');
  if (label.length > 60) throw new HttpRouteError(400, 'Sound label must be 60 characters or fewer.');
  if (!filename) throw new HttpRouteError(400, 'Sound file path is required.');
  if (filename.length > 240) throw new HttpRouteError(400, 'Sound file path must be 240 characters or fewer.');
  if (!filename.startsWith('/') && !/^https?:\/\//i.test(filename)) {
    throw new HttpRouteError(400, 'Sound file path must start with / or http(s)://.');
  }

  return { label, filename };
}

export function createSoundButton(body: unknown): SoundButton {
  seedSoundButtonsIfEmpty();
  const sound = normalizeSoundButtonBody(body);
  const id = crypto.randomUUID();
  createSoundButtonRow.run(id, sound.label, sound.filename);
  return getSoundButton.get(id) as SoundButton;
}

export function updateSoundButton(id: string, body: unknown): SoundButton {
  seedSoundButtonsIfEmpty();
  const existing = getSoundButton.get(id) as SoundButton | null;
  if (!existing) throw new HttpRouteError(404, 'Sound button not found.');

  const sound = normalizeSoundButtonBody(body);
  updateSoundButtonRow.run(sound.label, sound.filename, id);
  return getSoundButton.get(id) as SoundButton;
}

export function deleteSoundButton(id: string) {
  seedSoundButtonsIfEmpty();
  const existing = getSoundButton.get(id) as SoundButton | null;
  if (!existing) throw new HttpRouteError(404, 'Sound button not found.');
  deleteSoundButtonRow.run(id);
}

function playSound(src: string, volume = appConfig.quackVolume): SoundPlayback {
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
