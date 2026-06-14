// Dashboard data service. Phase 2: returns stub data.
// Phase 3: replace each function body with a real fetch/WebSocket call.
import type { Viewer, ChatEntry, StreamEvent, RunItem } from '../types';

const STUB_COLORS = {
  gold:   '#ffc488',
  silver: '#d7dce2',
  sage:   '#a8e0c4',
  sky:    '#9ccae8',
  violet: '#bca6f0',
  coral:  '#f0a99d',
  ivory:  '#f5f2e0',
};

const STUB_VIEWERS: Record<string, Viewer> = {
  stardust_kelly: {
    login: 'stardust_kelly', display: 'stardust_kelly', color: STUB_COLORS.violet,
    pronouns: 'she/her', roles: ['vip', 'sub'],
    followed: 'follows for 1y 3mo', subbed: 'subscribed 14 months · tier 1',
    seen: 'first seen Mar 2025', msgs: 4218, accountAge: 'account 3y 2mo',
    note: 'Mods love her — first to welcome new chatters. No warnings.',
    recent: [
      { t: 'the parallax on that starfield is unreal', ago: '0:12' },
      { t: 'wait can you show the easing curve again?', ago: '1:40' },
      { t: 'gifted a sub to moon_dev', ago: '6:02', kind: 'event' },
      { t: 'diogenes with a licensing agreement lmaooo', ago: '8:31' },
    ],
  },
  moon_dev: {
    login: 'moon_dev', display: 'moon_dev', color: STUB_COLORS.sky,
    pronouns: 'they/them', roles: ['sub'],
    followed: 'follows for 7 months', subbed: 'subscribed 2 months · gift',
    seen: 'first seen this stream', msgs: 96, accountAge: 'account 5 mo',
    note: 'New-ish. Gifted into the community by stardust_kelly tonight.',
    recent: [
      { t: 'first time catching you live, this is cozy', ago: '0:48' },
      { t: 'is the repo public?', ago: '3:22' },
      { t: 'thank you for the gift sub 🌙', ago: '5:55' },
    ],
  },
  grumpy_compiler: {
    login: 'grumpy_compiler', display: 'grumpy_compiler', color: STUB_COLORS.coral,
    pronouns: 'he/him', roles: ['mod', 'sub'],
    followed: 'follows for 2y 8mo', subbed: 'subscribed 31 months · tier 3',
    seen: 'first seen Jun 2023', msgs: 11904, accountAge: 'account 6y',
    note: 'Head mod. Trusted with everything. Runs the link bot.',
    recent: [
      { t: '!so @nebula_smith they stream rust on tuesdays', ago: '0:30' },
      { t: 'timed out a spammer, all clear', ago: '2:11', kind: 'mod' },
      { t: 'the auth refactor is gonna pay off, hold the line', ago: '4:49' },
    ],
  },
  nebula_smith: {
    login: 'nebula_smith', display: 'nebula_smith', color: STUB_COLORS.sage,
    pronouns: 'she/they', roles: [],
    followed: 'not following yet', subbed: 'not subscribed',
    seen: 'first seen this stream', msgs: 7, accountAge: 'account 11 days',
    note: 'Brand new account. Lurker so far — keep an eye, but friendly.',
    recent: [
      { t: 'hi! found you through the raid', ago: '1:05' },
      { t: 'what theme is that in the editor?', ago: '2:40' },
    ],
  },
  cosmic_jeff: {
    login: 'cosmic_jeff', display: 'cosmic_jeff', color: STUB_COLORS.gold,
    pronouns: 'he/him', roles: ['sub'],
    followed: 'follows for 1y 1mo', subbed: 'subscribed 9 months · tier 1',
    seen: 'first seen Apr 2025', msgs: 2051, accountAge: 'account 4y 6mo',
    note: 'Regular. Asks great questions about accessibility tooling.',
    recent: [
      { t: 'does the screen reader announce the live region update?', ago: '0:20' },
      { t: 'this is why I sub, actual teaching', ago: '3:58' },
    ],
  },
  pixel_witch: {
    login: 'pixel_witch', display: 'pixel_witch', color: STUB_COLORS.ivory,
    pronouns: 'she/her', roles: ['vip'],
    followed: 'follows for 1y 9mo', subbed: 'not subscribed',
    seen: 'first seen Sep 2024', msgs: 3380, accountAge: 'account 2y 9mo',
    note: 'Made the emote set. VIP for life. No warnings.',
    recent: [
      { t: 'the rim light on the orb came out so good', ago: '1:14' },
      { t: 'new emote when 👀', ago: '5:30' },
    ],
  },
};

const STUB_CHAT: ChatEntry[] = [
  { user: 'grumpy_compiler', text: '!so @nebula_smith they stream rust on tuesdays', time: '9:38' },
  { user: 'cosmic_jeff', text: 'does the screen reader announce the live region update?', time: '9:39' },
  { user: 'pixel_witch', text: 'the rim light on the orb came out so good', time: '9:39' },
  { user: 'nebula_smith', text: 'hi! found you through the raid', time: '9:40', highlight: 'first' },
  { user: 'moon_dev', text: 'first time catching you live, this is cozy', time: '9:40', highlight: 'first' },
  { user: 'stardust_kelly', text: 'diogenes with a licensing agreement lmaooo', time: '9:41' },
  { user: 'cosmic_jeff', text: 'this is why I sub, actual teaching', time: '9:41' },
  { user: 'nebula_smith', text: 'what theme is that in the editor?', time: '9:42' },
  { user: 'moon_dev', text: 'is the repo public?', time: '9:42' },
  { user: 'stardust_kelly', text: 'wait can you show the easing curve again?', time: '9:43' },
  { user: 'grumpy_compiler', text: 'the auth refactor is gonna pay off, hold the line', time: '9:43' },
  { user: 'pixel_witch', text: 'new emote when 👀', time: '9:44' },
  { user: 'cosmic_jeff', text: 'the contemplative-cozy-mystical thing really is the whole brand huh', time: '9:44' },
  { user: 'stardust_kelly', text: 'the parallax on that starfield is unreal', time: '9:45' },
  { user: 'moon_dev', text: 'thank you for the gift sub 🌙', time: '9:45', highlight: 'sub' },
];

const STUB_EVENTS: StreamEvent[] = [
  { kind: 'raid',   actor: 'aurora_codes',    detail: 'raided with 58 friends',          ago: '0:40',  tone: 'note' },
  { kind: 'gift',   actor: 'stardust_kelly',  detail: 'gifted 5 subs to the channel',    ago: '6:02',  tone: 'warning' },
  { kind: 'sub',    actor: 'cosmic_jeff',     detail: 'resubscribed · 9 months · tier 1', ago: '11:18', tone: 'warning' },
  { kind: 'cheer',  actor: 'pixel_witch',     detail: 'cheered 500 bits',                ago: '14:50', tone: 'info' },
  { kind: 'follow', actor: 'nebula_smith',    detail: 'followed',                        ago: '18:07', tone: 'silver' },
  { kind: 'sub',    actor: 'moon_dev',        detail: 'subscribed · gifted',             ago: '6:02',  tone: 'warning' },
  { kind: 'follow', actor: 'quiet_quasar',    detail: 'followed',                        ago: '22:30', tone: 'silver' },
  { kind: 'cheer',  actor: 'grumpy_compiler', detail: 'cheered 1000 bits',               ago: '24:12', tone: 'info' },
];

const STUB_RUNSHEET: RunItem[] = [
  { text: 'Thank last night’s raiders — aurora_codes brought a crowd', done: true },
  { text: 'Sponsor read: Fathom · keep it earnest, it’s assistive tech', done: true },
  { text: 'Today’s build: finish the auth refactor, show the token flow', done: false },
  { text: 'Remind chat the repo is public — link in panels', done: false },
  { text: 'Walk through the easing curve again for stardust_kelly', done: false },
  { text: 'Demo the screen-reader live region (cosmic_jeff asked)', done: false },
  { text: 'Plug the newsletter once, near the end — no hard sell', done: false },
  { text: 'Outro: a quiet character moment, then raid out', done: false },
];

const STUB_TICKER: string[] = [
  'aurora_codes raided with 58',
  'stardust_kelly gifted 5 subs',
  'nebula_smith followed',
  'cosmic_jeff resubscribed · 9 mo',
  'pixel_witch cheered 500 bits',
  'quiet_quasar followed',
];

export function getViewers(): Record<string, Viewer> {
  return STUB_VIEWERS;
}

export function getChatEntries(): ChatEntry[] {
  return STUB_CHAT;
}

export function getStreamEvents(): StreamEvent[] {
  return STUB_EVENTS;
}

export function getRunsheet(): RunItem[] {
  return STUB_RUNSHEET.map(r => ({ ...r }));
}

export function getTicker(): string[] {
  return STUB_TICKER;
}
