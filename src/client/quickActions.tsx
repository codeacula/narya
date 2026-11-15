// Manual automation triggers, rendered as buttons on the tablet. The dashboard has no
// quick-actions panel: one was written and registered in MODULES (622a5ff) but no
// dashboard layout ever mounted it, so it was removed rather than left as dead code.
// useQuickActions stays separate from the tablet chrome so a dashboard panel can be
// added back on top of it.
import React from 'react';
import type { AutomationTrigger, CategoryModulesResponse, TriggerRunResult } from '../shared/api';
import { getAutomationTriggers, getCategoryModules, runAutomationTrigger } from './services/dashboard';
import { useSocket } from './realtime';
import { runResultTone } from './pages/settings/automation';
import { errorMessage } from './errors';
import { EmptyState } from './ui/emptyState';
import { ListUnavailable, SettingsAnnouncer } from './pages/settings/shared';
import { listFace } from './pages/settings/listState';

export type QuickAction = {
  id: string;
  label: string;
  /** Null for a global trigger — always armed. */
  moduleId: string | null;
  moduleName: string | null;
  /** False when the trigger is scoped to a module that is not the active one. */
  armed: boolean;
};

export type QuickActionsState = {
  actions: QuickAction[];
  loading: boolean;
  /** The trigger list could not be loaded: `actions` is not "none", it is unknown. */
  loadError: string | null;
  /** The last run that failed to start. Says nothing about the list. */
  runError: string | null;
  retry: () => void;
  /** The most recent run, keyed by trigger id, so a partial run stays visible on the button. */
  runs: Record<string, TriggerRunResult>;
  runningId: string | null;
  run: (id: string) => void;
};

/**
 * Manual triggers, with each one's armed state derived from the live active module.
 * A module-scoped manual trigger is shown but not firable while its module is idle —
 * hiding it would make the button silently disappear when the game changes.
 */
export function useQuickActions(): QuickActionsState {
  const [triggers, setTriggers] = React.useState<AutomationTrigger[]>([]);
  const [modules, setModules] = React.useState<CategoryModulesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [runs, setRuns] = React.useState<Record<string, TriggerRunResult>>({});
  const [runningId, setRunningId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getAutomationTriggers(), getCategoryModules()])
      .then(([nextTriggers, nextModules]) => {
        if (cancelled) return;
        setTriggers(nextTriggers);
        setModules(nextModules);
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorMessage(caught, 'Could not load quick actions'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = React.useCallback(() => setAttempt(n => n + 1), []);

  useSocket<CategoryModulesResponse>('category-modules:updated', React.useCallback((payload) => {
    setModules(payload);
  }, []));

  const run = React.useCallback((id: string) => {
    setRunningId(id);
    setRunError(null);
    void runAutomationTrigger(id)
      .then(result => setRuns(current => ({ ...current, [id]: result })))
      .catch((caught: unknown) => {
        setRunError(errorMessage(caught, 'Could not run the action'));
      })
      .finally(() => setRunningId(null));
  }, []);

  const actions = React.useMemo<QuickAction[]>(() => {
    const activeModuleId = modules?.activeModuleId ?? null;
    const moduleNames = new Map((modules?.modules ?? []).map(module => [module.id, module.name]));

    return triggers
      .filter((trigger): trigger is Extract<AutomationTrigger, { kind: 'manual' }> => trigger.kind === 'manual')
      .filter(trigger => trigger.enabled)
      .map(trigger => ({
        id: trigger.id,
        label: trigger.config.label || 'Unlabelled',
        moduleId: trigger.moduleId,
        moduleName: trigger.moduleId ? moduleNames.get(trigger.moduleId) ?? 'Unknown module' : null,
        armed: trigger.moduleId === null || trigger.moduleId === activeModuleId,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [triggers, modules]);

  return { actions, loading, loadError, runError, retry, runs, runningId, run };
}

/** Tablet variant: reuses the tablet's own button chrome from styles.css. */
export function TabletQuickActions() {
  const { actions, loading, loadError, runError, retry, runs, runningId, run } = useQuickActions();
  const face = listFace({ loading, loadFailed: loadError !== null, count: actions.length });

  return (
    <section className="tablet-panel quick-actions-panel">
      <div className="tablet-panel-header">
        <div>
          <p className="eyebrow">Automation</p>
          <h2>Quick actions</h2>
        </div>
      </div>

      {/* The load error is the unavailable face below, not this line: drawing both
          put "No quick actions" under "Could not load quick actions". */}
      <SettingsAnnouncer error={runError} />
      {runError && <p className="tablet-error" aria-hidden="true">{runError}</p>}

      <div className="tablet-button-grid">
        {face === 'unavailable' ? (
          <ListUnavailable size="note" title="Quick actions unavailable" onRetry={retry} retrying={loading} />
        ) : face === 'loading' ? (
          <EmptyState size="note" title="Loading quick actions…" />
        ) : face === 'empty' ? (
          <EmptyState size="note" title="No quick actions">
            Add a Manual button trigger in Settings → Automation.
          </EmptyState>
        ) : actions.map(action => {
          const result = runs[action.id];
          const tone = result ? runResultTone(result) : null;
          return (
            <button
              key={action.id}
              className={tone ? `quick-action-tone-${tone}` : undefined}
              disabled={runningId === action.id || !action.armed}
              title={action.armed ? undefined : `Only fires while ${action.moduleName} is the active module.`}
              onClick={() => run(action.id)}
            >
              {action.label}
              {runningId === action.id ? ' …' : ''}
            </button>
          );
        })}
      </div>
    </section>
  );
}
