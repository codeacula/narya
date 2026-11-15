import { serviceStateTitle } from '../../connectionWords';

/**
 * What the voice picker says when it has no voices to offer, in the same
 * connected/offline words the Tengwar alert above it uses (connectionWords.ts). An empty
 * list is not always "offline": the probe may not have answered yet, or Tengwar may be
 * up and simply have no voices, and the picker must not contradict the alert.
 *
 * `reachable` is the probe's verdict: null while it has not answered.
 */
export function emptyVoicesCopy(reachable: boolean | null): { option: string; hint: string } {
  if (reachable === null) {
    return { option: 'Checking Tengwar…', hint: 'Voices load once Tengwar answers.' };
  }
  if (!reachable) {
    return {
      option: `No voices: ${serviceStateTitle('Tengwar', false)}`,
      hint: 'Check the Tengwar URL above, then save to retry.',
    };
  }
  return {
    option: 'No voices from Tengwar',
    hint: `${serviceStateTitle('Tengwar', true)}, but it listed no voices.`,
  };
}
