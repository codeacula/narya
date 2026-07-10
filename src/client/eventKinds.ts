import { THANK_WORTHY_EVENT_KINDS } from '../shared/constants';

/**
 * How each thank-worthy kind reads on screen. One table so the overlay ticker,
 * the Shoutouts tab, and the attention feed can't drift apart — a new kind is a
 * single entry here plus one in THANK_WORTHY_EVENT_KINDS.
 *
 * `verb` phrases a sentence ("subscribed"), `chip` labels a badge where space is
 * tight ("subbed").
 */
export type KindPresentation = { verb: string; chip: string; tone: string };

export const KIND_PRESENTATION: Record<string, KindPresentation> = {
  follow: { verb: 'followed', chip: 'followed', tone: 'note' },
  sub: { verb: 'subscribed', chip: 'subbed', tone: 'warning' },
  gift: { verb: 'gifted subs', chip: 'gifted', tone: 'warning' },
  cheer: { verb: 'cheered', chip: 'cheered', tone: 'info' },
  raid: { verb: 'raided', chip: 'raided', tone: 'note' },
  redeem: { verb: 'redeemed', chip: 'redeemed', tone: 'info' },
};

/** Chat isn't a stream event, so it has no entry above — it falls back to this. */
export const DEFAULT_KIND_TONE = 'silver';

export function kindTone(kind: string): string {
  return KIND_PRESENTATION[kind]?.tone ?? DEFAULT_KIND_TONE;
}

export function kindVerb(kind: string): string {
  return KIND_PRESENTATION[kind]?.verb ?? kind;
}

export function kindChip(kind: string): string {
  return KIND_PRESENTATION[kind]?.chip ?? kind;
}

export const ATTENTION_EVENT_KINDS: ReadonlySet<string> = new Set(THANK_WORTHY_EVENT_KINDS);
