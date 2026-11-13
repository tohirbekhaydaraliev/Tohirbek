import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Empty, ErrorNotice, LoadingPage } from '../components/ui';
import { post } from '../lib/api';
import { date, num, pct, SOURCE_LABEL, value, VERDICT_LABEL } from '../lib/format';
import { useApi, useApp } from '../lib/hooks';

interface LearningData {
  stats: Array<{ type: string; label: string; executed: number; evaluated: number; improved: number; worsened: number; noChange: number; successRate: number | null }>;
  history: Array<{
    id: string;
    typeLabel: string;
    title: string;
    risk: string;
    source: string;
    status: string;
    rationale: string | null;
    decidedBy: string | null;
    createdAt: string;
    resultSummary: string | null;
    outcome: { label: string; unit: any; baseline: number | null; observed: number | null; verdict: string } | null;
  }>;
  pendingOutcomes: number;
}

const VERDICT_COLOR: Record<string, string> = { improved: 'var(--good)', worsened: 'var(--critical)', no_change: 'var(--axis)' };

export function LearningPage() {
  const { toast } = useApp();
  const { data, error, reload } = useApi<LearningData>('/api/learning');
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;

  const evaluate = async () => {
    setBusy(true);
    try {
      const res = await post<unknown[]>('/api/outcomes/evaluate');
      toast(`${res.length} ta natija baholandi`);
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>O'rganish (Feedback Loop)</h1>
          <div className="sub">Decision → Context → Action → Outcome. Har bir harakat natijasi o'lchanadi va keyingi tavsiyalar ishonchliligiga ta'sir qiladi.</div>
        </div>
        <button className="btn" onClick={evaluate} disabled={busy}>
          <Icon name="refresh" size={16} /> Natijalarni baholash {data.pendingOutcomes ? `(${data.pendingOutcomes} kutilmoqda)` : ''}
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Harakat turlari bo'yicha samaradorlik</h2>
          <div className="legend">
            {(['improved', 'no_change', 'worsened'] as const).map((v) => (
              <span key={v} className="legend-item">
                <span className="legend-swatch" style={{ background: VERDICT_COLOR[v] }} />
                {VERDICT_LABEL[v]}
              </span>
            ))}
          </div>
        </div>
        {data.stats.length === 0 ? (
          <Empty>Hali baholangan harakatlar yo'q</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Harakat turi</th>
                  <th className="num">Bajarilgan</th>
                  <th className="num">Baholangan</th>
                  <th style={{ width: '34%' }}>Natijalar</th>
                  <th className="num">Muvaffaqiyat</th>
                </tr>
              </thead>
              <tbody>
                {data.stats.map((s) => (
                  <tr key={s.type}>
                    <td className="small strong">{s.label}</td>
                    <td className="num small">{num(s.executed)}</td>
                    <td className="num small">{num(s.evaluated)}</td>
                    <td>
                      {s.evaluated > 0 ? (
                        <div style={{ display: 'flex', gap: 2, height: 10 }} title={`${s.improved} yaxshilandi, ${s.noChange} o'zgarmadi, ${s.worsened} yomonlashdi`}>
                          {s.improved > 0 && <div style={{ flex: s.improved, background: VERDICT_COLOR.improved, borderRadius: '4px 0 0 4px' }} />}
                          {s.noChange > 0 && <div style={{ flex: s.noChange, background: VERDICT_COLOR.no_change }} />}
                          {s.worsened > 0 && <div style={{ flex: s.worsened, background: VERDICT_COLOR.worsened, borderRadius: '0 4px 4px 0' }} />}
                        </div>
                      ) : (
                        <span className="tiny muted">natija kutilmoqda</span>
                      )}
                    </td>
                    <td className="num small strong">{s.successRate !== null ? pct(s.successRate, 0) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Qarorlar tarixi</h2>
          <span className="hint">AI agentlar shu tarixdan "nima ishlagan, nima ishlamagan"ni o'rganadi</span>
        </div>
        <div className="stack" style={{ gap: 0 }}>
          {data.history.map((h) => (
            <div key={h.id} style={{ padding: '12px 0', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '110px minmax(0,1fr)', gap: 14 }}>
              <div className="tiny muted">
                {date(h.createdAt)}
                <div>{SOURCE_LABEL[h.source] ?? h.source}</div>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="small strong">{h.title}</span>
                  <span className="badge">{h.typeLabel}</span>
                  {h.status !== 'executed' && <span className="badge">{h.status === 'rejected' ? 'Rad etilgan' : "E'tiborsiz"}</span>}
                </div>
                {h.rationale && <div className="small ink2">{h.rationale}</div>}
                {h.resultSummary && <div className="tiny muted">Natija: {h.resultSummary}</div>}
                {h.outcome && (
                  <div className="outcome-line">
                    <span className={`badge ${h.outcome.verdict === 'improved' ? 'sev-good' : h.outcome.verdict === 'worsened' ? 'sev-critical' : ''}`}>
                      <Icon name={h.outcome.verdict === 'improved' ? 'up' : h.outcome.verdict === 'worsened' ? 'down' : 'clock'} size={12} stroke={2.2} />
                      {VERDICT_LABEL[h.outcome.verdict]}
                    </span>
                    <span>
                      {h.outcome.label}: {value(h.outcome.baseline, h.outcome.unit)}
                      {h.outcome.observed !== null ? ` → ${value(h.outcome.observed, h.outcome.unit)}` : ''}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
