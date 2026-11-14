import type { OverlayAdBreak } from '../shared/api';
import { useLiveValue } from './liveValue';
import { getOverlayAdBreak } from './services/dashboard';

const NO_BREAK: OverlayAdBreak = { endsAt: null };

/** REST seed + live `overlay:ad-break`. The end time of a running ad break, or null. */
export function useAdBreak(): string | null {
  const [adBreak] = useLiveValue<OverlayAdBreak>(getOverlayAdBreak, 'overlay:ad-break', NO_BREAK);
  return adBreak.endsAt;
}
