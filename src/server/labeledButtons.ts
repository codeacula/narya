import { db } from './db';
import { HttpRouteError } from './http';

export type LabeledButton = {
  id: string;
  label: string;
  filename: string;
};

export type LabeledButtonUpdate = {
  label: string;
  filename: string;
};

export type LabeledButtonRepoOptions<TButton extends LabeledButton, TPlayback> = {
  table: string;
  notFoundMessage: string;
  validate: (body: unknown) => LabeledButtonUpdate;
  play: (button: TButton) => TPlayback | null;
};

export type LabeledButtonRepo<TButton extends LabeledButton, TPlayback> = {
  list: () => TButton[];
  get: (id: string) => TButton | null;
  create: (body: unknown) => TButton;
  update: (id: string, body: unknown) => TButton;
  remove: (id: string) => void;
  trigger: (id: string) => TPlayback | null;
};

export function createLabeledButtonRepo<TButton extends LabeledButton, TPlayback>(
  options: LabeledButtonRepoOptions<TButton, TPlayback>,
): LabeledButtonRepo<TButton, TPlayback> {
  const { table, notFoundMessage, validate, play } = options;

  const listRows = db.prepare(`
  select id, label, filename
  from ${table}
  order by label collate nocase
`);
  const getRow = db.prepare(`
  select id, label, filename
  from ${table}
  where id = ?
`);
  const createRow = db.prepare(`
  insert into ${table} (id, label, filename)
  values (?, ?, ?)
`);
  const updateRow = db.prepare(`
  update ${table}
  set label = ?, filename = ?
  where id = ?
`);
  const deleteRow = db.prepare(`delete from ${table} where id = ?`);

  const get = (id: string) => getRow.get(id) as TButton | null;

  return {
    list: () => listRows.all() as TButton[],
    get,
    create(body: unknown) {
      const next = validate(body);
      const id = crypto.randomUUID();
      createRow.run(id, next.label, next.filename);
      return getRow.get(id) as TButton;
    },
    update(id: string, body: unknown) {
      const existing = get(id);
      if (!existing) throw new HttpRouteError(404, notFoundMessage);

      const next = validate(body);
      updateRow.run(next.label, next.filename, id);
      return getRow.get(id) as TButton;
    },
    remove(id: string) {
      const existing = get(id);
      if (!existing) throw new HttpRouteError(404, notFoundMessage);
      deleteRow.run(id);
    },
    trigger(id: string) {
      const button = get(id);
      if (!button) return null;
      return play(button);
    },
  };
}
