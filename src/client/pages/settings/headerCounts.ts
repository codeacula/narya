/**
 * The count line under a settings header ("3 counters", "12 saved · 2 hidden"). Every
 * section that shows one passes the numbers to `SettingsHeader` as data rather than
 * markup, so the line is set the same way everywhere.
 */
export type HeaderCount = {
  value: number;
  /** The noun for exactly one ("counter"). */
  one: string;
  /** The noun for any other number. Defaults to `one` + "s". */
  other?: string;
  /** Leave the count out entirely when it is zero ("0 hidden" says nothing). */
  hideWhenZero?: boolean;
};

export type HeaderCountPart = { value: number; label: string };

export function headerCountParts(counts: ReadonlyArray<HeaderCount>): HeaderCountPart[] {
  return counts
    .filter(count => !(count.hideWhenZero && count.value === 0))
    .map(count => ({
      value: count.value,
      label: count.value === 1 ? count.one : count.other ?? `${count.one}s`,
    }));
}
