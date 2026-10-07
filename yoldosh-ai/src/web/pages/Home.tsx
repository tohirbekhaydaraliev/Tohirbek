import { useState } from 'react';
import type { ActionView, Business, Diagnosis, Finding } from '../../shared/types';
import { ActionCard } from '../components/ActionCard';
import { Icon } from '../components/Icon';
import { Empty, ErrorNotice, LoadingPage, SeverityBadge, StatTile } from '../components/ui';
import { post } from '../lib/api';
import { ago, date, money, signedPct } from '../lib/format';
import { useApi, useApp } from '../lib/hooks';

interface Overview {
  business: Business;
  diagnosis: Diagnosis | null;
  pendingActions: ActionView[];
  recentActions: ActionView[];
  findings: Finding[];
  connectors: Array<{ id: string; type: string; name: string; status: string; lastSyncAt: string | null; lastError: string | null }>;
  aiEnabled: boolean;
}

const SUGGESTIONS = ['Bu oy nima bo‘lyapti?', 'Nega daromad tushdi?', 'Qaysi kampaniya samarasiz?', 'Bugun nimaga e’tibor berishim kerak?'];

export function HomePage() {
  const { navigate, toast } = useApp();
  const { data, error, loading, reload, setData } = useApi<Overview>('/api/overview');
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);

  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <LoadingPage text="Biznes holati yuklanmoqda..." />;

  const d = data.diagnosis;
  const kpi = (key: string) => d?.kpis.find((k) => k.key === key);
  const revenue = kpi('revenue');
  const topRec = d?.recommendations.find((r) => r.actionId && r.actionStatus === 'proposed') ?? d?.recommendations[0];
  const topAction = topRec?.actionId ? data.pendingActions.find((a) => a.id === topRec.actionId) : undefined;

  const ask = (q: string) => {
    if (!q.trim()) return;
    navigate(`suhbat?q=${encodeURIComponent(q.trim())}`);
  };

  const runNow = async () => {
    setRunning(true);
    try {
      await post('/api/diagnoses', {});
      await reload();
      toast('Diagnostika yangilandi');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const updateAction = (a: ActionView) =>
    setData({
      ...data,
      pendingActions: data.pendingActions.filter((x) => x.id !== a.id || a.status === 'proposed'),
      recentActions: a.status !== 'proposed' ? [a, ...data.recentActions] : data.recentActions,
    });

  return (
    <div className={`page ${loading ? 'fade' : ''}`}>
      <div className="page-head">
        <div>
          <h1>{data.business.name}</h1>
          <div className="sub">
            {d ? `Oxirgi diagnostika: ${date(d.createdAt, true)} · so'nggi ${d.windowDays} kun oldingi ${d.windowDays} kunga nisbatan` : "Diagnostika hali o'tkazilmagan"}
          </div>
        </div>
        <button className="btn" onClick={runNow} disabled={running}>
          <Icon name="refresh" size={16} /> {running ? 'Tekshirilmoqda...' : 'Hozir tekshirish'}
        </button>
      </div>

      <div className="grid grid-main">
        <div className="stack" style={{ gap: 16 }}>
        <div className="card agent-card">
          <div className="agent-top">
            <div className="agent-label">
              <span className="pulse" /> Yo'ldosh AI · biznes agenti
            </div>
            {d && revenue ? (
              <>
                <div className="hero-figure">
                  <span className="value">
                    Daromad {revenue.change !== null && revenue.change < 0 ? '↓' : '↑'} {signedPct(Math.abs(revenue.change ?? 0)).replace('+', '')}
                  </span>
                  <span className="what">
                    {money(revenue.previous)} → {money(revenue.current)}
                  </span>
                </div>
                {d.rootCause ? (
                  <dl className="cause-grid">
                    <dt>Asosiy sabab</dt>
                    <dd>{d.rootCause.headline}</dd>
                    <dt>Asosiy omil</dt>
                    <dd>{d.rootCause.mainFactor}</dd>
                    {topRec && (
                      <>
                        <dt>Tavsiya etilgan harakat</dt>
                        <dd>{topRec.title}</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="ink2">Jiddiy salbiy o'zgarish aniqlanmadi. Biznes barqaror.</p>
                )}
              </>
            ) : (
              <Empty>Diagnostika natijasi yo'q — "Hozir tekshirish" tugmasini bosing.</Empty>
            )}
          </div>
          {d && (
            <div className="agent-actions">
              {topAction ? (
                <ApproveInline action={topAction} onDone={updateAction} />
              ) : topRec?.actionStatus ? (
                <span className="badge sev-good">
                  <Icon name="check" size={12} /> Tavsiya holati: {topRec.actionStatus === 'executed' ? 'bajarildi' : topRec.actionStatus}
                </span>
              ) : null}
              <button className="btn" onClick={() => navigate('diagnostika')}>
                <Icon name="eye" size={16} /> Tekshirish
              </button>
              <button className="btn ghost" onClick={() => ask('Nega daromad tushdi? Sabablarini batafsil tahlil qil.')}>
                <Icon name="chat" size={16} /> AI'dan so'rash
              </button>
            </div>
          )}
        </div>

      <div className="card">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <Icon name="sparkles" />
            <input className="input spacer" style={{ width: 'auto' }} placeholder="Biznesingiz haqida savol bering: “Bu oy nima bo‘lyapti?”" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <button className="btn primary" type="submit">
              <Icon name="send" size={16} /> So'rash
            </button>
          </form>
          <div className="chips" style={{ marginTop: 10 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
          {!data.aiEnabled && (
            <div className="tiny muted" style={{ marginTop: 10 }}>
              AI (Claude) ulanmagan — javoblar diagnostika engine'idan. Multi-agent tahlil uchun serverda ANTHROPIC_API_KEY ni o'rnating.
            </div>
          )}
        </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Bugungi ustuvorliklar</h2>
            <span className="hint">{data.findings.length} ta ochiq signal</span>
          </div>
          {d && d.priorities.length ? (
            <ol className="priorities">
              {d.priorities.slice(0, 5).map((p) => (
                <li key={p.rank}>
                  <span className="prio-rank">{p.rank}</span>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="prio-title">{p.title}</span>
                      {p.severity === 'critical' && <SeverityBadge severity="critical" />}
                    </div>
                    <div className="prio-detail">{p.detail}</div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>Ustuvor muammolar yo'q</Empty>
          )}
        </div>
      </div>

      {d && (
        <div className="tiles">
          {['revenue', 'leads', 'conversion_rate', 'cac', 'response_time_minutes', 'active_customers'].map((k) => {
            const item = kpi(k);
            return item ? <StatTile key={k} kpi={item} windowDays={d.windowDays} /> : null;
          })}
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Tasdig'ingizni kutmoqda</h2>
            <button className="btn ghost sm" onClick={() => navigate('harakatlar')}>
              Barchasi <Icon name="chevronRight" size={14} />
            </button>
          </div>
          <div className="stack">
            {data.pendingActions.length ? (
              data.pendingActions.slice(0, 4).map((a) => <ActionCard key={a.id} action={a} compact onChange={updateAction} />)
            ) : (
              <Empty>Tasdiq kutayotgan harakat yo'q</Empty>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>AI bajargan harakatlar</h2>
            <span className="hint">past xavfli harakatlar avtomatik</span>
          </div>
          <div className="stack" style={{ gap: 0 }}>
            {data.recentActions.length ? (
              data.recentActions.slice(0, 7).map((a) => (
                <div key={a.id} className="row" style={{ padding: '9px 0', borderTop: '1px solid var(--border)', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <span style={{ color: a.status === 'executed' ? 'var(--good)' : 'var(--muted)', marginTop: 2 }}>
                    <Icon name={a.status === 'executed' ? 'check' : 'x'} size={16} />
                  </span>
                  <div className="spacer" style={{ minWidth: 0 }}>
                    <div className="small strong">{a.title}</div>
                    <div className="tiny muted">{(a.result as any)?.summary ?? a.error ?? a.status}</div>
                  </div>
                  <span className="tiny muted nowrap">{ago(a.executedAt ?? a.createdAt)}</span>
                </div>
              ))
            ) : (
              <Empty>Hali harakat bajarilmagan</Empty>
            )}
          </div>
        </div>
      </div>

      <div className="card flat">
        <div className="row small">
          <span className="section-title">Ma'lumot manbalari</span>
          {data.connectors.map((c) => (
            <span key={c.id} className={`badge ${c.lastError ? 'critical' : 'good'}`}>
              <span className="dot" /> {c.name}
            </span>
          ))}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => navigate('integratsiyalar')}>
            Integratsiyalar <Icon name="chevronRight" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ApproveInline({ action, onDone }: { action: ActionView; onDone: (a: ActionView) => void }) {
  const { toast, refreshCounts } = useApp();
  const [busy, setBusy] = useState(false);
  const go = async (op: 'approve' | 'ignore') => {
    setBusy(true);
    try {
      const a = await post<ActionView>(`/api/actions/${action.id}/${op}`);
      onDone(a);
      refreshCounts();
      toast(op === 'approve' ? (a.status === 'executed' ? `Bajarildi: ${(a.result as any)?.summary ?? ''}` : `Xato: ${a.error}`) : "E'tiborsiz qoldirildi");
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn primary" disabled={busy} onClick={() => go('approve')}>
        <Icon name="check" size={16} /> {busy ? 'Bajarilmoqda...' : 'Tasdiqlash'}
      </button>
      <button className="btn ghost" disabled={busy} onClick={() => go('ignore')}>
        E'tiborsiz qoldirish
      </button>
    </>
  );
}
