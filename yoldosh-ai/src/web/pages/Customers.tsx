import { useEffect, useState } from 'react';
import type { Customer360 } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorNotice, LoadingPage, Meter, Modal, Segmented } from '../components/ui';
import { api, post } from '../lib/api';
import { ago, date, money, pct } from '../lib/format';
import { useApi, useApp } from '../lib/hooks';

interface Item {
  id: string;
  fullName: string | null;
  phone: string | null;
  source: string | null;
  segment: string | null;
  status: string | null;
  revenue: number;
  churnProbability: number | null;
  churnLevel: string | null;
  churnReason: string | null;
  firstSeenAt: string;
}

const LEVEL_LABEL: Record<string, string> = { high: 'Yuqori', medium: "O'rta", low: 'Past' };

export function CustomersPage({ openId }: { openId?: string | null }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [risk, setRisk] = useState<'all' | 'high' | 'medium'>('high');
  const [selected, setSelected] = useState<string | null>(openId ?? null);
  const path = `/api/customers?limit=80${query ? `&q=${encodeURIComponent(query)}` : ''}${risk !== 'all' ? `&risk=${risk}` : ''}`;
  const { data, error, loading, reload } = useApi<Item[]>(path, [path]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Mijozlar 360</h1>
          <div className="sub">Universal Customer ID: bir mijozning reklamadan daromadgacha bo'lgan butun hayot sikli</div>
        </div>
        <div className="row">
          <input className="input" style={{ width: 260 }} placeholder="Ism yoki telefon bo'yicha qidirish" value={q} onChange={(e) => setQ(e.target.value)} />
          <Segmented
            value={risk}
            onChange={setRisk}
            options={[
              { value: 'high', label: 'Churn xavfi yuqori' },
              { value: 'medium', label: "O'rta+" },
              { value: 'all', label: 'Hammasi' },
            ]}
          />
        </div>
      </div>
      {error && <ErrorNotice error={error} onRetry={reload} />}
      {!data ? (
        <LoadingPage />
      ) : (
        <div className={`card ${loading ? 'fade' : ''}`}>
          {data.length === 0 ? (
            <Empty>Mijoz topilmadi</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Mijoz</th>
                    <th>Segment</th>
                    <th>Holat</th>
                    <th className="num">Daromad</th>
                    <th>Churn ehtimoli</th>
                    <th>Asosiy sabab</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => setSelected(c.id)}>
                      <td>
                        <div className="strong small">{c.fullName ?? 'Nomaʼlum'}</div>
                        <div className="tiny muted tnum">{c.phone}</div>
                      </td>
                      <td className="small">{c.segment ?? '—'}</td>
                      <td className="small muted">{c.status ?? '—'}</td>
                      <td className="num small">{money(c.revenue)}</td>
                      <td style={{ minWidth: 150 }}>
                        <Meter value={c.churnProbability} />
                      </td>
                      <td className="small ink2">{c.churnReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {selected && <CustomerDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CustomerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { toast } = useApp();
  const [c, setC] = useState<Customer360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setC(null);
    api<Customer360>(`/api/customers/${id}`)
      .then(setC)
      .catch((e) => setError((e as Error).message));
  }, [id]);

  const retention = async () => {
    if (!c) return;
    setBusy(true);
    try {
      const res = await post('/api/actions', {
        type: 'retention_outreach',
        params: { customerIds: [c.id], note: `Churn sabablari: ${c.churnReasons.join('; ') || '—'}` },
        title: `${c.fullName ?? 'Mijoz'} bilan bog'lanish (retention)`,
      });
      toast(res.action.status === 'executed' ? `Vazifa yaratildi: ${(res.action.result as any)?.summary ?? ''}` : 'Harakat yaratildi');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal drawer title={c?.fullName ?? 'Customer 360'} onClose={onClose}>
      {error && <ErrorNotice error={error} />}
      {!c ? (
        !error && <LoadingPage />
      ) : (
        <>
          <div className="row small muted">
            <span className="tnum">{c.phone}</span>
            {c.telegram && <span>@{c.telegram}</span>}
            <span className="copy" title="Universal Customer ID">
              {c.id}
            </span>
          </div>
          <dl className="kv">
            <dt>Manba</dt>
            <dd>{c.source ?? '—'}</dd>
            <dt>Kampaniya</dt>
            <dd>{c.campaign ?? '—'}</dd>
            <dt>Birinchi aloqa</dt>
            <dd>{date(c.firstContactAt)}</dd>
            <dt>Sotuv menejeri</dt>
            <dd>{c.salesManager ?? '—'}</dd>
            <dt>Kurs / mahsulot</dt>
            <dd>
              {c.product ?? c.segment ?? '—'}
              {c.group ? <span className="muted"> · {c.group}</span> : null}
            </dd>
            <dt>Sinov darsi</dt>
            <dd>{date(c.trialAt)}</dd>
            <dt>Xarid</dt>
            <dd>{date(c.purchaseAt)}</dd>
            <dt>Daromad</dt>
            <dd>{money(c.revenue, { short: false })}</dd>
            <dt>Davomat</dt>
            <dd>{c.attendanceRate !== null ? pct(c.attendanceRate, 0) : '—'}</dd>
            <dt>Oxirgi faollik</dt>
            <dd>{ago(c.lastActivityAt)}</dd>
            <dt>Churn ehtimoli</dt>
            <dd>
              {c.churnProbability !== null ? (
                <div className="stack" style={{ gap: 4 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className={`badge ${c.churnLevel === 'high' ? 'critical' : c.churnLevel === 'medium' ? 'warning' : 'good'}`}>
                      <span className="dot" />
                      {LEVEL_LABEL[c.churnLevel ?? 'low']}
                    </span>
                    <span className="tnum">{pct(c.churnProbability, 0)}</span>
                  </div>
                  {c.churnReasons.map((r) => (
                    <span key={r} className="small ink2">
                      • {r}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="muted">{c.subscriptionStatus ? `obuna: ${c.subscriptionStatus}` : '—'}</span>
              )}
            </dd>
          </dl>
          {c.subscriptionStatus === 'active' && (
            <div className="row">
              <button className="btn primary" onClick={retention} disabled={busy}>
                <Icon name="users" size={16} /> Retention vazifasi yaratish
              </button>
            </div>
          )}
          {c.openTasks.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="section-title">Ochiq vazifalar</div>
              {c.openTasks.map((t) => (
                <div key={t.id} className="small">
                  • {t.title} <span className="muted">({date(t.dueAt, true)})</span>
                </div>
              ))}
            </div>
          )}
          <div className="stack" style={{ gap: 8 }}>
            <div className="section-title">Hayot sikli</div>
            <div className="timeline">
              {c.timeline.map((t, i) => (
                <div key={i} className={`tl-item ${t.kind}`}>
                  <div className="small strong">{t.title}</div>
                  <div className="tiny muted">
                    {date(t.at, true)}
                    {t.detail ? ` · ${t.detail}` : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="section-title">Bog'langan identifikatorlar (identity resolution)</div>
            <div className="row" style={{ gap: 6 }}>
              {c.identities.map((i) => (
                <span key={`${i.kind}:${i.value}`} className="badge">
                  {i.kind}: {i.value.length > 22 ? `${i.value.slice(0, 22)}…` : i.value}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
