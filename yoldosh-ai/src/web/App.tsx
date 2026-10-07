import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './components/Icon';
import { LoadingPage } from './components/ui';
import { api, ApiError, post, setToken } from './lib/api';
import { AppContext, useHashRoute } from './lib/hooks';
import { ActionsPage } from './pages/Actions';
import { ChatPage } from './pages/Chat';
import { ContextPage } from './pages/Context';
import { CustomersPage } from './pages/Customers';
import { DiagnosisPage } from './pages/Diagnosis';
import { FunnelPage } from './pages/Funnel';
import { HomePage } from './pages/Home';
import { IntegrationsPage } from './pages/Integrations';
import { LearningPage } from './pages/Learning';

interface Meta {
  aiEnabled: boolean;
  model: string | null;
  authRequired: boolean;
  businesses: Array<{ id: string; name: string }>;
}

const NAV = [
  { path: '', label: 'Agent', icon: 'home' },
  { path: 'diagnostika', label: 'Diagnostika', icon: 'pulse' },
  { path: 'harakatlar', label: 'Harakatlar', icon: 'checkSquare', badge: true },
  { path: 'suhbat', label: 'CEO Agent', icon: 'chat' },
  { path: 'voronka', label: 'Voronka', icon: 'funnel' },
  { path: 'mijozlar', label: 'Mijozlar 360', icon: 'users' },
  { path: 'kontekst', label: 'Biznes konteksti', icon: 'sliders' },
  { path: 'integratsiyalar', label: 'Integratsiyalar', icon: 'plug' },
  { path: 'organish', label: "O'rganish", icon: 'brain' },
] as const;

const THEME_KEY = 'yoldosh.theme';

function useTheme(): [string | null, () => void] {
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);
  const toggle = () => {
    const isDark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  };
  return [theme, toggle];
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form
        className="card stack"
        style={{ width: 'min(400px, 100%)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          setToken(value.trim());
          try {
            await api('/api/business');
            onDone();
          } catch {
            setToken(null);
            setError("Token noto'g'ri");
          }
        }}
      >
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark">
            <Icon name="sparkles" size={18} />
          </div>
          <div>
            <div className="brand-name">Yo'ldosh AI</div>
            <div className="brand-sub">Kirish</div>
          </div>
        </div>
        <div className="field">
          <label>API token</label>
          <input className="input" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          <span className="help">Server sozlamasidagi YOLDOSH_API_TOKEN</span>
        </div>
        {error && <div className="notice error small">{error}</div>}
        <button className="btn primary" type="submit">
          Kirish
        </button>
      </form>
    </div>
  );
}

export function App() {
  const [path, params, navigate] = useHashRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [noBusiness, setNoBusiness] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [, toggleTheme] = useTheme();

  const loadMeta = useCallback(async () => {
    try {
      const m = await api<Meta>('/api/meta');
      setMeta(m);
      setNoBusiness(m.businesses.length === 0);
      setNeedLogin(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedLogin(true);
    }
  }, []);

  const refreshCounts = useCallback(async () => {
    try {
      const pending = await api<unknown[]>('/api/actions?status=pending&limit=200');
      setPendingCount(pending.length);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    if (meta && !noBusiness) void refreshCounts();
  }, [meta, noBusiness, path, refreshCounts]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg((m) => (m === msg ? null : m)), 4500);
  }, []);

  const ctx = useMemo(() => ({ navigate, toast, aiEnabled: !!meta?.aiEnabled, refreshCounts }), [navigate, toast, meta?.aiEnabled, refreshCounts]);

  if (needLogin) return <Login onDone={loadMeta} />;
  if (!meta) return <LoadingPage text="Yo'ldosh AI yuklanmoqda..." />;
  if (noBusiness) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
        <div className="card stack" style={{ width: 'min(460px, 100%)', textAlign: 'center' }}>
          <h2>Biznes hali yo'q</h2>
          <p className="small muted">Demo biznes ("Edinburg" o'quv markazi) ma'lumotlari bilan boshlang yoki integratsiyalarni ulang.</p>
          <button
            className="btn primary"
            onClick={async () => {
              await post('/api/demo/reset');
              await loadMeta();
            }}
          >
            Demo ma'lumotlarni yuklash
          </button>
        </div>
      </div>
    );
  }

  const page = (() => {
    switch (path) {
      case 'diagnostika':
        return <DiagnosisPage />;
      case 'harakatlar':
        return <ActionsPage />;
      case 'suhbat':
        return <ChatPage initialQuestion={params.get('q')} />;
      case 'voronka':
        return <FunnelPage />;
      case 'mijozlar':
        return <CustomersPage openId={params.get('id')} />;
      case 'kontekst':
        return <ContextPage />;
      case 'integratsiyalar':
        return <IntegrationsPage />;
      case 'organish':
        return <LearningPage />;
      default:
        return <HomePage />;
    }
  })();

  const navItems = NAV.map((n) => (
    <button key={n.path} className={`nav-item ${path === n.path ? 'active' : ''}`} onClick={() => navigate(n.path)}>
      <Icon name={n.icon} />
      {n.label}
      {'badge' in n && n.badge && pendingCount > 0 && <span className="count">{pendingCount}</span>}
    </button>
  ));

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" aria-hidden="true">
                <circle cx="11" cy="13" r="5" />
                <circle cx="18.5" cy="5.5" r="2" fill="#fff" stroke="none" />
              </svg>
            </div>
            <div>
              <div className="brand-name">Yo'ldosh AI</div>
              <div className="brand-sub">Business Operating Agent</div>
            </div>
          </div>
          {navItems}
          <div className="sidebar-foot">
            <span className={`badge ${meta.aiEnabled ? 'good' : 'warning'}`} title={meta.model ?? undefined}>
              <span className="dot" /> {meta.aiEnabled ? `AI: ${meta.model}` : 'AI: engine rejimi'}
            </span>
            <span>{meta.businesses[0]?.name}</span>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn ghost sm" onClick={toggleTheme} aria-label="Mavzuni almashtirish">
                <Icon name="moon" size={15} /> Mavzu
              </button>
              {meta.authRequired && (
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    setToken(null);
                    setNeedLogin(true);
                  }}
                >
                  <Icon name="logout" size={15} /> Chiqish
                </button>
              )}
            </div>
          </div>
        </aside>
        <div style={{ minWidth: 0 }}>
          <nav className="mobile-nav">{navItems}</nav>
          <main className="main">{page}</main>
        </div>
      </div>
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </AppContext.Provider>
  );
}
