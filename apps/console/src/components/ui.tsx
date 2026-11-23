import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { STATUS_LABEL, TONE } from '../format';

export function Status({ value }: { value: string }) {
  return <span className={`badge ${TONE[value] ?? 'neutral'}`}>{STATUS_LABEL[value] ?? value}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="error">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice">{children}</div>;
}

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <header className="page-head">
        <h1>{title}</h1>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** Loads data on mount and on reload(). Keeps the last good data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    run()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [run]);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

/** A button that runs an async action, disables itself while running and reports failure. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
