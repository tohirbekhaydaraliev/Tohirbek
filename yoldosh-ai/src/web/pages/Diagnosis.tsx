import { useEffect, useState } from 'react';
import type { ActionView, Diagnosis, TreeNode } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Delta, Empty, ErrorNotice, LoadingPage, Markdown, RiskBadge, Segmented, SeverityBadge, StatTile } from '../components/ui';
import { post } from '../lib/api';
import { date, pct, signedPct, STATUS_LABEL, value } from '../lib/format';
import { useApi, useApp } from '../lib/hooks';

interface HistoryItem {
  id: string;
  kind: string;
  windowDays: number;
  createdAt: string;
  generatedBy: string;
  headline: string | null;
  revenueChange: number | null;
}

const GOOD_DOWN = /^(driver\.(response_time|unanswered)|renewal\.(churn|overdue))/;

function TreeRow({ node, depth, open, toggle }: { node: TreeNode; depth: number; open: Set<string>; toggle: (k: string) => void }) {
  const hasChildren = node.children.length > 0;
  const isOpen = open.has(node.key);
  const good = GOOD_DOWN.test(node.key) ? 'down' : 'up';
  const share = node.share !== null && node.relation !== 'driver' && node.relation !== 'evidence' ? node.share : null;
  return (
    <>
      <div className={`tree-row ${node.onPath ? 'on-path' : ''}`}>
        <div className="tree-label" style={{ paddingLeft: depth * 18 }}>
          {hasChildren ? (
            <button className="tree-toggle" onClick={() => toggle(node.key)} aria-expanded={isOpen} aria-label={isOpen ? 'Yig‘ish' : 'Ochish'}>
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
            </button>
          ) : (
            <span style={{ width: 20, flex: 'none' }} />
          )}
          <div style={{ minWidth: 0 }}>
            <div className="tree-name" title={node.label}>
              {node.onPath && <span style={{ color: 'var(--accent-ink)' }}>● </span>}
              {node.label}
            </div>
            {node.note && <div className="tree-note">{node.note}</div>}
          </div>
        </div>
        <div className="tree-values">
          {node.relation === 'evidence' ? value(node.current, node.unit) : `${value(node.previous, node.unit)} → ${value(node.current, node.unit)}`}
        </div>
        <div style={{ textAlign: 'right' }}>{node.relation === 'evidence' ? null : <Delta change={node.change} good={good} />}</div>
        <div className="share-bar">
          {share !== null && (
            <>
              <div className="share-track" title="Ota ko'rsatkich o'zgarishidagi ulush">
                <div className="share-fill" style={{ width: `${Math.min(100, Math.abs(share) * 100)}%`, opacity: share < 0 ? 0.45 : 1 }} />
              </div>
              <span className="tnum">{Math.round(share * 100)}%</span>
            </>
          )}
        </div>
      </div>
      {isOpen && node.children.map((c) => <TreeRow key={c.key} node={c} depth={depth + 1} open={open} toggle={toggle} />)}
    </>
  );
}

function collectPath(node: TreeNode, acc = new Set<string>()): Set<string> {
  if (node.onPath) acc.add(node.key);
  node.children.forEach((c) => collectPath(c, acc));
  return acc;
}

export function DiagnosisPage() {
  const { toast, navigate } = useApp();
  const history = useApi<HistoryItem[]>('/api/diagnoses');
  const [selected, setSelected] = useState<string | null>(null);
  const current = useApi<Diagnosis | null>(selected ? `/api/diagnoses/${selected}` : '/api/diagnoses/latest', [selected]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [windowDays, setWindowDays] = useState(30);
  const [running, setRunning] = useState(false);
  const d = current.data;

  useEffect(() => {
    if (d) setOpen(collectPath(d.tree));
  }, [d?.id]);

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const run = async () => {
    setRunning(true);
    try {
      const nd = await post<Diagnosis>('/api/diagnoses', { windowDays });
      setSelected(nd.id);
      await history.reload();
      toast('Yangi diagnostika tayyor');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const approve = async (actionId: string) => {
    try {
      const a = await post<ActionView>(`/api/actions/${actionId}/approve`);
      toast(a.status === 'executed' ? `Bajarildi: ${(a.result as any)?.summary ?? ''}` : `Xato: ${a.error}`);
      await current.reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  if (current.error) return <ErrorNotice error={current.error} onRetry={current.reload} />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Biznes diagnostikasi</h1>
          <div className="sub">Detect → Diagnose → Recommend: KPI daraxti bo'ylab sababiy tahlil</div>
        </div>
        <div className="row">
          <Segmented
            value={windowDays}
            onChange={setWindowDays}
            options={[
              { value: 7, label: '7 kun' },
              { value: 14, label: '14 kun' },
              { value: 30, label: '30 kun' },
              { value: 60, label: '60 kun' },
            ]}
          />
          <button className="btn primary" onClick={run} disabled={running}>
            <Icon name="refresh" size={16} /> {running ? 'Tekshirilmoqda...' : 'Hozir tekshirish'}
          </button>
        </div>
      </div>

      {!d ? (
        current.loading ? <LoadingPage /> : <Empty>Diagnostika yo'q</Empty>
      ) : (
        <div className={`grid grid-main ${current.loading ? 'fade' : ''}`}>
          <div className="stack" style={{ gap: 16 }}>
            <div className="card">
              <div className="card-head">
                <h2>Xulosa</h2>
                <span className="hint">
                  {date(d.createdAt, true)} · {d.generatedBy === 'ai' ? `AI (${d.model})` : 'diagnostika engine'} · {d.windowDays} kun
                </span>
              </div>
              {d.narrative ? <Markdown text={d.narrative} /> : <Empty>Matn yo'q</Empty>}
            </div>

            {d.rootCause && (
              <div className="card">
                <div className="card-head">
                  <h2>Root cause</h2>
                  <span className="badge accent">Ishonch: {pct(d.rootCause.confidence, 0)}</span>
                </div>
                <dl className="cause-grid" style={{ marginBottom: 14 }}>
                  <dt>Asosiy muammo</dt>
                  <dd>{d.rootCause.headline}</dd>
                  <dt>Asosiy omil</dt>
                  <dd>{d.rootCause.mainFactor}</dd>
                </dl>
                <div className="section-title" style={{ marginBottom: 6 }}>
                  Dalillar
                </div>
                <ul className="md" style={{ margin: 0, paddingLeft: 20 }}>
                  {d.rootCause.evidence.map((e) => (
                    <li key={e} className="small">
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="stack" style={{ gap: 16 }}>
            <div className="card">
              <div className="card-head">
                <h2>Tavsiyalar</h2>
              </div>
              <div className="stack">
                {d.recommendations.length ? (
                  d.recommendations.map((r) => (
                    <div key={r.title} className="action-card">
                      <div className="action-title">{r.title}</div>
                      <div className="action-meta">
                        <RiskBadge risk={r.risk} />
                        <span className="tiny muted">Ishonch {pct(r.confidence, 0)}</span>
                        {r.actionStatus && <span className="badge">{STATUS_LABEL[r.actionStatus]}</span>}
                      </div>
                      <div className="small ink2">{r.expectedImpact}</div>
                      {r.actionId && r.actionStatus === 'proposed' && (
                        <div className="row">
                          <button className="btn primary sm" onClick={() => approve(r.actionId!)}>
                            <Icon name="check" size={14} /> Tasdiqlash
                          </button>
                          <button className="btn ghost sm" onClick={() => navigate('harakatlar')}>
                            Batafsil
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <Empty>Tavsiya yo'q</Empty>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Ustuvorliklar</h2>
              </div>
              <ol className="priorities">
                {d.priorities.map((p) => (
                  <li key={p.rank}>
                    <span className="prio-rank">{p.rank}</span>
                    <div>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="prio-title">{p.title}</span>
                        <SeverityBadge severity={p.severity} />
                      </div>
                      <div className="prio-detail">{p.detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Tarix</h2>
              </div>
              <div className="stack" style={{ gap: 2 }}>
                {(history.data ?? []).slice(0, 12).map((h) => (
                  <button key={h.id} className={`nav-item ${h.id === d.id ? 'active' : ''}`} onClick={() => setSelected(h.id)} style={{ alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="small strong">
                        {date(h.createdAt, true)} · {h.kind === 'daily' ? 'kunlik' : 'qo‘lda'}
                      </div>
                      <div className="tiny muted" style={{ whiteSpace: 'normal' }}>
                        {h.headline ?? 'Jiddiy muammo yo‘q'} {h.revenueChange !== null ? `· daromad ${signedPct(h.revenueChange)}` : ''}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-head">
              <h2>KPI daraxti</h2>
              <span className="hint">● — root cause yo'li · ulush — ota ko'rsatkich o'zgarishidagi hissa</span>
            </div>
            <div className="tree" role="tree">
              <TreeRow node={d.tree} depth={0} open={open} toggle={toggle} />
            </div>
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <div className="section-title" style={{ marginBottom: 10 }}>
              Barcha ko'rsatkichlar
            </div>
            <div className="tiles">
              {d.kpis.map((k) => (
                <StatTile key={k.key} kpi={k} windowDays={d.windowDays} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
