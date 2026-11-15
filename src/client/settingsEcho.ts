/**
 * Tells a `settings:updated` broadcast caused by this window's own save from one that
 * came from somewhere else.
 *
 * The server broadcasts `settings:updated` on every `PUT /api/config`, to every window,
 * including the one that saved. That window already reports the save beside the form
 * (`SettingsStatus`, the settings feedback rule in pages/settings/shared.tsx), so a
 * "Settings saved" toast on top said it twice. Only a save made elsewhere — another
 * dashboard window — is news here.
 *
 * The broadcast is sent before the PUT's response, so it usually lands while the save is
 * still in flight; one that lands after is recognised by the `updatedAt` the response
 * carried, which is the same value the broadcast carries.
 */
export function createSettingsEchoFilter() {
  let inFlight = 0;
  const ownStamps = new Set<string>();
  return {
    /** Wraps a local save, so its own broadcast is recognised. */
    track<T extends { updatedAt?: string | null }>(save: Promise<T>): Promise<T> {
      inFlight += 1;
      return save
        .then(result => {
          if (result.updatedAt) ownStamps.add(result.updatedAt);
          return result;
        })
        .finally(() => { inFlight -= 1; });
    },
    /** True when this broadcast is the echo of a save this window made. */
    isOwnEcho(updatedAt: string): boolean {
      return inFlight > 0 || ownStamps.has(updatedAt);
    },
  };
}

/** The one filter for this window: `updateAppConfig` tracks, `ServiceStatusToasts` asks. */
export const settingsEcho = createSettingsEchoFilter();
