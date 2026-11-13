import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './components/Icon';
import { CreateBusinessForm } from './components/CreateBusiness';
import { LoadingPage, Modal } from './components/ui';
import { api, ApiError, getBusinessId, post, setBusinessId, setToken } from './lib/api';
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
  const [businessId, setBusinessIdState] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [, toggleTheme] = useTheme();

  const loadMeta = useCallback(async () => {
    try {
      const m = await api<Meta>('/api/meta');
      // Saqlangan biznes ro'yxatda bo'lmasa — birinchisi tanlanadi
      const stored = getBusinessId();
      const current = m.businesses.find((b) => b.id === stored)?.id ?? m.businesses[0]?.id ?? null;
      setBusinessId(current);
      setBusinessIdState(current);
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
  }, [meta, noBusiness, path, businessId, refreshCounts]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg((m) => (m === msg ? null : m)), 4500);
  }, []);

  const ctx = useMemo(() => ({ navigate, toast, aiEnabled: !!meta?.aiEnabled, refreshCounts }), [navigate, toast, meta?.aiEnabled, refreshCounts]);

  if (needLogin) return <Login onDone={loadMeta} />;
  if (!meta) return <LoadingPage text="Yo'ldosh AI yuklanmoqda..." />;
  const onCreated = async (b: { id: string; name: string }) => {
    setBusinessId(b.id);
    setCreating(false);
    await loadMeta();
    navigate('');
    toast(`"${b.name}" yaratildi. Endi integratsiyalarni ulang.`);
  };

  const switchBusiness = (id: string) => {
    setBusinessId(id);
    setBusinessIdState(id);
    navigate('');
  };

  if (noBusiness) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
        <div className="card stack" style={{ width: 'min(560px, 100%)' }}>
          <div className="brand" style={{ padding: 0 }}>
            <div className="brand-mark">
              <Icon name="sparkles" size={18} />
            </div>
            <div>
              <div className="brand-name">Yo'ldosh AI</div>
              <div className="brand-sub">Biznesingizni qo'shing</div>
            </div>
          </div>
          <CreateBusinessForm onCreated={onCreated} />
          <div className="row small muted" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <span className="spacer">Avval ko'rib chiqmoqchimisiz?</span>
            <button
              className="btn sm"
              onClick={async () => {
                await post('/api/demo/reset');
                await loadMeta();
              }}
            >
              Demo biznesni yuklash
            </button>
          </div>
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
            {meta.businesses.length > 1 ? (
              <select className="select" style={{ padding: '4px 8px', fontSize: 13 }} value={businessId ?? ''} onChange={(e) => switchBusiness(e.target.value)} aria-label="Biznesni tanlash">
                {meta.businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : (
              <span>{meta.businesses[0]?.name}</span>
            )}
            <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => setCreating(true)}>
              <Icon name="plus" size={15} /> Yangi biznes
            </button>
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
          <main className="main" key={businessId ?? 'none'}>
            {page}
          </main>
        </div>
      </div>
      {creating && (
        <Modal title="Yangi biznes" onClose={() => setCreating(false)}>
          <CreateBusinessForm onCreated={onCreated} onCancel={() => setCreating(false)} />
        </Modal>
      )}
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </AppContext.Provider>
  );
}
