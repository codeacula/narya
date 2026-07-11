import type { SettingsRoute } from '../../routing';

/**
 * Every settings section, in rail order. This is the only place a section is declared:
 * the left rail renders from it, `SettingsHeader` takes each page's eyebrow, title, and
 * intro from it, and `SettingsShell` picks the body by id. Adding a section here and to
 * the shell's switch is the whole job — there is no second list to keep in step.
 */
export type SettingsGroupId = 'channel' | 'automation' | 'studio';

export type SettingsSection = {
  id: SettingsRoute;
  group: SettingsGroupId;
  /** The rail entry. Short — it sits in a 236px column. */
  label: string;
  title: string;
  blurb: string;
};

export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; label: string }> = [
  { id: 'channel', label: 'channel' },
  { id: 'automation', label: 'automation' },
  { id: 'studio', label: 'studio' },
];

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: 'settings',
    group: 'channel',
    label: 'Connections',
    title: 'Connections',
    blurb: 'Sign in to Twitch, then point Narya at OBS, Discord, and the speech server. Saving reconnects only the service you changed — no restart.',
  },
  {
    id: 'golive',
    group: 'channel',
    label: 'Go live',
    title: 'Go live',
    blurb: 'What happens the moment Twitch confirms you are live: the Discord announcement and the scene OBS starts from.',
  },
  {
    id: 'categories',
    group: 'channel',
    label: 'Categories',
    title: 'Stream categories',
    blurb: 'Tags you set on a category replace your stream tags automatically when you switch to it in Stream Info. Linked reward groups flip on with it too.',
  },
  {
    id: 'rewards',
    group: 'channel',
    label: 'Viewer rewards',
    title: 'Viewer rewards',
    blurb: 'Create and organize Twitch Channel Points rewards. Toggle a category to switch its manageable rewards on or off together.',
  },
  {
    id: 'actions',
    group: 'automation',
    label: 'Actions',
    title: 'Actions',
    blurb: 'An action is a named, reusable list of steps. Triggers run one; you can also run one by hand to test it. Each step’s delay is measured from the start of the run, not from the previous step — so text, media, and speech can land together.',
  },
  {
    id: 'automation',
    group: 'automation',
    label: 'Triggers',
    title: 'Triggers',
    blurb: 'A trigger is a source that fires one action. A trigger with no module is global — always armed. A module-scoped one only fires while its module is the active one.',
  },
  {
    id: 'modules',
    group: 'automation',
    label: 'Modules',
    title: 'Category modules',
    blurb: 'A module owns Twitch categories and channel-point reward groups. Switching game deactivates one module and activates another, turning its reward groups on and the outgoing module’s off.',
  },
  {
    id: 'content',
    group: 'studio',
    label: 'Media',
    title: 'Media',
    blurb: 'The clips and sounds Narya is allowed to play, and the buttons that reach them from the tablet and the overlays.',
  },
  {
    id: 'speech',
    group: 'studio',
    label: 'Speech',
    title: 'Speech',
    blurb: 'The Chatterbox voice behind !tts and every speak step. Test it here before a viewer does.',
  },
  {
    id: 'ai',
    group: 'studio',
    label: 'AI',
    title: 'AI',
    blurb: 'The model behind LLM steps. The API key is stored on the backend and never sent back to this page.',
  },
];

const BY_ID = new Map(SETTINGS_SECTIONS.map(section => [section.id, section]));

export function settingsSection(id: SettingsRoute): SettingsSection {
  const section = BY_ID.get(id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

export function sectionsInGroup(group: SettingsGroupId): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(section => section.group === group);
}
