import React from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
};

type ToastInput = Omit<Toast, 'id'> & { durationMs?: number };

type ToastContextValue = {
  pushToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 6000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const dismissToast = React.useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = React.useCallback((toast: ToastInput) => {
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    const { durationMs, ...rest } = toast;
    setToasts((current) => [...current, { ...rest, id }]);
    const ttl = durationMs ?? DEFAULT_DURATION_MS;
    if (ttl > 0) {
      setTimeout(() => dismissToast(id), ttl);
    }
  }, [dismissToast]);

  const value = React.useMemo(() => ({ pushToast, dismissToast }), [pushToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toastStack" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.kind}`} role="status">
            <div className="toast-body">
              <div className="toast-title">{toast.title}</div>
              {toast.message ? <div className="toast-message">{toast.message}</div> : null}
            </div>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    // Allow components rendered outside the provider (e.g. overlay pages) to no-op.
    return { pushToast: () => undefined, dismissToast: () => undefined };
  }
  return context;
}
