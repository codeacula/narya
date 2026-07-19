// Manual automation triggers, rendered as buttons for the dashboard and the tablet.
// Both surfaces share useQuickActions; only the chrome differs (the dashboard uses
// kebab-case panel.css classes, the tablet the camelCase classes in styles.css).
import React from 'react';
import type { ActionRunResult, AutomationTrigger, CategoryModulesResponse } from '../shared/api';
import { getAutomationTriggers, getCategoryModules, runAutomationTrigger } from './services/dashboard';
import { useSocket } from './realtime';
import { runResultTone, summarizeRunResult } from './pages/settings/automation';
import { errorMessage } from './errors';

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
  error: string | null;
  /** The most recent run, keyed by trigger id, so a partial run stays visible on the button. */
  runs: Record<string, ActionRunResult>;
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
  const [error, setError] = React.useState<string | null>(null);
  const [runs, setRuns] = React.useState<Record<string, ActionRunResult>>({});
  const [runningId, setRunningId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([getAutomationTriggers(), getCategoryModules()])
      .then(([nextTriggers, nextModules]) => {
        if (cancelled) return;
        setTriggers(nextTriggers);
        setModules(nextModules);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught, 'Could not load quick actions'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useSocket<CategoryModulesResponse>('category-modules:updated', React.useCallback((payload) => {
    setModules(payload);
  }, []));

  const run = React.useCallback((id: string) => {
    setRunningId(id);
    void runAutomationTrigger(id)
      .then(result => setRuns(current => ({ ...current, [id]: result })))
      .catch((caught: unknown) => {
        setError(errorMessage(caught, 'Could not run the action'));
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

  return { actions, loading, error, runs, runningId, run };
}

/** Dashboard panel. Registered in the MODULES registry by the integrator. */
export function QuickActionsPanel() {
  const { actions, loading, error, runs, runningId, run } = useQuickActions();

  return (
    <div className="quick-actions">
      {error && <div className="quick-actions-error">{error}</div>}

      {loading ? (
        <div className="command-empty">Loading quick actions...</div>
      ) : actions.length === 0 ? (
        <div className="command-empty">
          No manual triggers. Add one in Settings → Automation → Manual button.
        </div>
      ) : (
        <div className="quick-actions-grid">
          {actions.map(action => {
            const result = runs[action.id];
            const tone = result ? runResultTone(result) : null;
            return (
              <button
                className={'quick-action' + (tone ? ` quick-action--${tone}` : '') + (action.armed ? '' : ' quick-action--disarmed')}
                type="button"
                key={action.id}
                disabled={runningId === action.id || !action.armed}
                title={action.armed
                  ? (result ? summarizeRunResult(result) : action.moduleName ?? 'Global')
                  : `Only fires while ${action.moduleName} is the active module.`}
                onClick={() => run(action.id)}
              >
                <span className="quick-action-label">{action.label}</span>
                <span className="quick-action-scope">{action.moduleName ?? 'global'}</span>
                {runningId === action.id && <span className="quick-action-state">running…</span>}
                {runningId !== action.id && result && (
                  <span className={`quick-action-state quick-action-state--${tone}`}>{result.status}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Tablet variant: reuses the tablet's own button chrome from styles.css. */
export function TabletQuickActions() {
  const { actions, loading, error, runs, runningId, run } = useQuickActions();

  return (
    <section className="tablet-panel quick-actions-panel">
      <div className="tablet-panel-header">
        <div>
          <p className="eyebrow">Automation</p>
          <h2>Quick actions</h2>
        </div>
      </div>

      {error && <p className="tablet-error">{error}</p>}

      <div className="tablet-button-grid">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : actions.length === 0 ? (
          <p className="muted">No manual triggers — add them in Settings → Automation.</p>
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
