import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Oddiy ma'lumot yuklash hook'i: qayta yuklashda oldingi natija saqlanadi (layout sakramaydi). */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (id === seq.current) setError((err as Error).message);
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

/** Hash router: #/diagnostika, #/mijozlar?id=... */
export function useHashRoute(): [string, URLSearchParams, (to: string) => void] {
  const parse = () => {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [path, query] = raw.split('?');
    return { path: path || '', params: new URLSearchParams(query ?? '') };
  };
  const [state, setState] = useState(parse);
  useEffect(() => {
    const onChange = () => setState(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((to: string) => {
    window.location.hash = `/${to.replace(/^\//, '')}`;
  }, []);
  return [state.path, state.params, navigate];
}

export interface AppCtx {
  navigate: (to: string) => void;
  toast: (msg: string) => void;
  aiEnabled: boolean;
  refreshCounts: () => void;
}

export const AppContext = createContext<AppCtx>({
  navigate: () => {},
  toast: () => {},
  aiEnabled: false,
  refreshCounts: () => {},
});

export const useApp = () => useContext(AppContext);
