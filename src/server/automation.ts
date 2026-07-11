import type { ActionExecutor } from './actionExecutor';
import { createActionExecutor } from './actionExecutor';
import { resolveMediaAssetForPlayback } from './mediaAssets';
import type { RuntimeState } from './runtime';

/**
 * Composition root for the automation platform.
 *
 * The executor and the trigger dispatcher are needed by `index.ts` (to register
 * routes), by `eventsub.ts`, and by `chat.ts`. None of those can import from
 * `index.ts` — where RuntimeState is constructed — without a module cycle, so
 * the wiring lives here and `index.ts` initializes it at startup.
 *
 * Media resolution is injected rather than imported by the executor: it is the
 * single choke point that stops a disabled, missing, or unconfigured asset from
 * ever reaching an overlay, and keeping it a port is what makes the executor
 * testable without a database full of files.
 */
let executor: ActionExecutor | null = null;

export function initAutomation(state: RuntimeState): void {
  executor = createActionExecutor({
    resolveMedia: resolveMediaAssetForPlayback,
    state,
  });
}

function requireInit<T>(value: T | null, name: string): T {
  if (!value) throw new Error(`Automation: ${name} was used before initAutomation() ran.`);
  return value;
}

export function getActionExecutor(): ActionExecutor {
  return requireInit(executor, 'the action executor');
}
