import { useEffect, useState } from 'react';
import type { Business, BusinessSettings } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorNotice, LoadingPage, Modal, RiskBadge, Switch } from '../components/ui';
import { del, patch, post } from '../lib/api';
import { ago, value } from '../lib/format';
import { useApi, useApp } from '../lib/hooks';

interface Target {
  id: string;
  kind: 'goal' | 'kpi' | 'constraint';
  metric: string;
  label: string;
  target: number;
  comparator: 'gte' | 'lte';
  segment: string | null;
}
interface Rule {
  id: string;
  name: string;
  description: string | null;
  detector: string;
  params: Record<string, number>;
  action_type: string;
  action_params: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  last_result: { findings: number; proposed: number; executed: number; pending: number; errors: string[] } | null;
}
interface Detector {
  key: string;
  label: string;
  description: string;
  params: Array<{ key: string; label: string; default: number; unit?: string }>;
  actions: string[];
}
interface ContextData {
  business: Business;
  targets: Target[];
  rules: Rule[];
  detectors: Detector[];
  metrics: Record<string, { label: string; unit: string; defaultComparator: 'gte' | 'lte' }>;
  actions: Array<{ type: string; label: string; baseRisk: string }>;
}

const KIND_LABEL = { goal: 'Maqsad', kpi: 'KPI', constraint: 'Cheklov' };

export function ContextPage() {
  const { data, error, reload, setData } = useApi<ContextData>('/api/context');
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Biznes konteksti</h1>
          <div className="sub">AI'ga "biznes nima istaydi?" degan savolga javob beradigan qatlam: maqsadlar, KPI'lar, qoidalar va avtonomiya.</div>
        </div>
      </div>
      <div className="grid grid-2">
        <Profile business={data.business} onSaved={(b) => setData({ ...data, business: b })} />
        <Autonomy business={data.business} onSaved={(b) => setData({ ...data, business: b })} />
      </div>
      <Targets data={data} reload={reload} />
      <Rules data={data} reload={reload} />
    </div>
  );
}

function Profile({ business, onSaved }: { business: Business; onSaved: (b: Business) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState(business.name);
  const [strategy, setStrategy] = useState(business.strategy ?? '');
  const [priorities, setPriorities] = useState(business.priorities.join(', '));
  const save = async () => {
    try {
      const b = await patch<Business>('/api/business', {
        name,
        strategy,
        priorities: priorities.split(',').map((s) => s.trim()).filter(Boolean),
      });
      onSaved(b);
      toast('Saqlandi');
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <div className="card stack">
      <h2>Biznes profili</h2>
      <div className="field">
        <label>Nomi</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Strategiya</label>
        <textarea className="textarea" value={strategy} onChange={(e) => setStrategy(e.target.value)} />
        <span className="help">AI agentlar qaror chiqarishda shu strategiyani hisobga oladi.</span>
      </div>
      <div className="field">
        <label>Ustuvor yo'nalishlar (vergul bilan)</label>
        <input className="input" value={priorities} onChange={(e) => setPriorities(e.target.value)} />
      </div>
      <div>
        <button className="btn primary" onClick={save}>
          Saqlash
        </button>
      </div>
    </div>
  );
}

function Autonomy({ business, onSaved }: { business: Business; onSaved: (b: Business) => void }) {
  const { toast } = useApp();
  const [s, setS] = useState<BusinessSettings>(business.settings);
  useEffect(() => setS(business.settings), [business.settings]);
  const set = <K extends keyof BusinessSettings>(k: K, v: BusinessSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      onSaved(await patch<Business>('/api/business', { settings: s }));
      toast('Avtonomiya sozlamalari saqlandi');
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const levelRow = (risk: 'low' | 'medium' | 'high', desc: string) => (
    <div className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)', flexWrap: 'nowrap' }}>
      <div style={{ minWidth: 0 }}>
        <RiskBadge risk={risk} />
        <div className="tiny muted" style={{ marginTop: 4 }}>
          {desc}
        </div>
      </div>
      {risk === 'high' ? (
        <span className="badge">Faqat inson tasdig'i</span>
      ) : (
        <select className="select" style={{ width: 170 }} value={s.autonomy[risk]} onChange={(e) => set('autonomy', { ...s.autonomy, [risk]: e.target.value as 'auto' | 'approval' })}>
          <option value="auto">AI o'zi bajaradi</option>
          <option value="approval">Tasdiq bilan</option>
        </select>
      )}
    </div>
  );
  return (
    <div className="card stack">
      <h2>Human-in-the-loop: avtonomiya</h2>
      <div>
        {levelRow('low', 'CRM yangilash, vazifa, hisobot, xodimga xabar')}
        {levelRow('medium', 'Byudjetni o‘zgartirish, leadlarni qayta taqsimlash, mijozga muhim xabar')}
        {levelRow('high', 'Katta byudjet o‘zgarishi, pul qaytarish, moliyaviy tranzaksiyalar')}
      </div>
      <Switch checked={s.agentLowRiskAuto} onChange={(v) => set('agentLowRiskAuto', v)} label="Chatda AI taklif qilgan past xavfli harakatlarni avtomatik bajarish" />
      <div className="grid grid-2" style={{ gap: 12 }}>
        <NumField label="Javob SLA (daqiqa)" value={s.responseSlaMinutes} onChange={(v) => set('responseSlaMinutes', v)} />
        <NumField label="Javobsiz lead (soat)" value={s.unansweredHours} onChange={(v) => set('unansweredHours', v)} />
        <NumField label="Churn chegarasi (0–1)" value={s.churnThreshold} step={0.05} onChange={(v) => set('churnThreshold', v)} />
        <NumField label="Diagnostika oynasi (kun)" value={s.diagnosisWindowDays} onChange={(v) => set('diagnosisWindowDays', v)} />
        <NumField label="Kunlik diagnostika soati" value={s.dailyDigestHour} onChange={(v) => set('dailyDigestHour', v)} />
        <NumField label="Byudjet o'zgarishi > % → yuqori xavf" value={s.maxBudgetChangePct} onChange={(v) => set('maxBudgetChangePct', v)} />
      </div>
      <div>
        <button className="btn primary" onClick={save}>
          Saqlash
        </button>
      </div>
    </div>
  );
}

function NumField({ label, value: v, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input tnum" type="number" step={step} value={v} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Targets({ data, reload }: { data: ContextData; reload: () => void }) {
  const { toast } = useApp();
  const [editing, setEditing] = useState<Partial<Target> | null>(null);
  const save = async () => {
    if (!editing?.metric || editing.target === undefined) return;
    try {
      const body = { kind: editing.kind ?? 'kpi', metric: editing.metric, label: editing.label, target: Number(editing.target), comparator: editing.comparator, segment: editing.segment || null };
      if (editing.id) await patch(`/api/context/targets/${editing.id}`, body);
      else await post('/api/context/targets', body);
      setEditing(null);
      reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const remove = async (id: string) => {
    await del(`/api/context/targets/${id}`);
    reload();
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>Maqsadlar va KPI chegaralari</h2>
        <button className="btn sm" onClick={() => setEditing({ kind: 'kpi' })}>
          <Icon name="plus" size={14} /> Qo'shish
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Turi</th>
              <th>Nomi</th>
              <th>Metrika</th>
              <th className="num">Maqsad</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.targets.map((t) => (
              <tr key={t.id}>
                <td>
                  <span className="badge">{KIND_LABEL[t.kind]}</span>
                </td>
                <td className="small strong">{t.label}</td>
                <td className="small muted">
                  {t.metric}
                  {t.segment ? ` · ${t.segment}` : ''}
                </td>
                <td className="num small">
                  {t.comparator === 'lte' ? '≤' : '≥'} {value(t.target, (data.metrics[t.metric]?.unit as any) ?? 'count')}
                </td>
                <td className="num">
                  <button className="btn ghost sm" onClick={() => setEditing(t)}>
                    Tahrirlash
                  </button>
                  <button className="btn ghost sm danger" onClick={() => remove(t.id)} aria-label="O'chirish">
                    <Icon name="trash" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal title={editing.id ? 'Maqsadni tahrirlash' : 'Yangi maqsad / KPI'} onClose={() => setEditing(null)}>
          <div className="field">
            <label>Metrika</label>
            <select
              className="select"
              value={editing.metric ?? ''}
              onChange={(e) => {
                const m = data.metrics[e.target.value];
                setEditing({ ...editing, metric: e.target.value, label: editing.label || m?.label, comparator: m?.defaultComparator });
              }}
            >
              <option value="">Tanlang...</option>
              {Object.entries(data.metrics).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label>Turi</label>
              <select className="select" value={editing.kind ?? 'kpi'} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Target['kind'] })}>
                <option value="goal">Maqsad</option>
                <option value="kpi">KPI</option>
                <option value="constraint">Cheklov</option>
              </select>
            </div>
            <div className="field">
              <label>Taqqoslash</label>
              <select className="select" value={editing.comparator ?? 'gte'} onChange={(e) => setEditing({ ...editing, comparator: e.target.value as 'gte' | 'lte' })}>
                <option value="gte">≥ (kamida)</option>
                <option value="lte">≤ (ko'pi bilan)</option>
              </select>
            </div>
            <div className="field">
              <label>Qiymat</label>
              <input className="input" type="number" value={editing.target ?? ''} onChange={(e) => setEditing({ ...editing, target: Number(e.target.value) })} />
              <span className="help">Ulushlar 0–1 oralig'ida (12% = 0.12)</span>
            </div>
            <div className="field">
              <label>Segment (ixtiyoriy)</label>
              <input className="input" value={editing.segment ?? ''} onChange={(e) => setEditing({ ...editing, segment: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Nomi</label>
            <input className="input" value={editing.label ?? ''} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
          </div>
          <div className="row">
            <button className="btn primary" onClick={save}>
              Saqlash
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Rules({ data, reload }: { data: ContextData; reload: () => void }) {
  const { toast } = useApp();
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState(false);
  const detector = (k: string) => data.detectors.find((d) => d.key === k);
  const actionLabel = (t: string) => data.actions.find((a) => a.type === t)?.label ?? t;

  const update = async (r: Rule, patchBody: Partial<Rule>) => {
    try {
      await patch(`/api/context/rules/${r.id}`, {
        name: r.name,
        description: r.description,
        detector: r.detector,
        params: r.params,
        action_type: r.action_type,
        action_params: r.action_params,
        enabled: r.enabled,
        ...patchBody,
      });
      reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const runNow = async () => {
    setRunning(true);
    try {
      const res = await post<Array<{ proposed: number }>>('/api/rules/run');
      toast(`Qoidalar ishga tushdi: ${res.reduce((a, r) => a + r.proposed, 0)} ta yangi harakat`);
      reload();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Biznes qoidalari</h2>
          <div className="hint">IF shart THEN harakat — har 10 daqiqada avtomatik tekshiriladi</div>
        </div>
        <div className="row">
          <button className="btn sm" onClick={runNow} disabled={running}>
            <Icon name="refresh" size={14} /> {running ? 'Ishlamoqda...' : 'Hozir ishga tushirish'}
          </button>
          <button className="btn sm primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> Qoida
          </button>
        </div>
      </div>
      <div className="stack">
        {data.rules.length === 0 && <Empty>Qoidalar yo'q</Empty>}
        {data.rules.map((r) => {
          const det = detector(r.detector);
          return (
            <div key={r.id} className="action-card">
              <div className="action-head">
                <div className="stack" style={{ gap: 4 }}>
                  <div className="action-title">{r.name}</div>
                  <div className="small ink2">
                    <span className="strong">AGAR</span> {det?.label ?? r.detector}
                    {det?.params.map((p) => (
                      <span key={p.key}>
                        {' '}
                        · {p.label}:{' '}
                        <input
                          className="input tnum"
                          type="number"
                          step={p.default < 1 ? 0.05 : 1}
                          defaultValue={r.params[p.key] ?? p.default}
                          style={{ width: 80, padding: '2px 6px', display: 'inline-block' }}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== (r.params[p.key] ?? p.default)) void update(r, { params: { ...r.params, [p.key]: v } });
                          }}
                        />{' '}
                        {p.unit ?? ''}
                      </span>
                    ))}{' '}
                    <span className="strong">→ UNDA</span> {actionLabel(r.action_type)}
                  </div>
                  {r.description && <div className="tiny muted">{r.description}</div>}
                  {r.last_run_at && r.last_result && (
                    <div className="tiny muted">
                      Oxirgi tekshiruv {ago(r.last_run_at)}: {r.last_result.findings} ta signal, {r.last_result.proposed} ta harakat ({r.last_result.executed} bajarildi, {r.last_result.pending} tasdiq kutmoqda)
                      {r.last_result.errors?.length ? ` · xato: ${r.last_result.errors[0]}` : ''}
                    </div>
                  )}
                </div>
                <Switch checked={r.enabled} onChange={(v) => update(r, { enabled: v })} label="" />
              </div>
            </div>
          );
        })}
      </div>
      {creating && <NewRule data={data} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

function NewRule({ data, onClose, onSaved }: { data: ContextData; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [detKey, setDetKey] = useState(data.detectors[0]?.key ?? '');
  const det = data.detectors.find((d) => d.key === detKey);
  const [params, setParams] = useState<Record<string, number>>({});
  const [action, setAction] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    if (!det) return;
    setParams(Object.fromEntries(det.params.map((p) => [p.key, p.default])));
    setAction(det.actions[0]);
  }, [detKey]);
  const save = async () => {
    try {
      await post('/api/context/rules', { name: name || `${det?.label} → ${data.actions.find((a) => a.type === action)?.label}`, detector: detKey, params, action_type: action, enabled: true });
      onSaved();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <Modal title="Yangi biznes qoidasi" onClose={onClose}>
      <div className="field">
        <label>AGAR (shart)</label>
        <select className="select" value={detKey} onChange={(e) => setDetKey(e.target.value)}>
          {data.detectors.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        <span className="help">{det?.description}</span>
      </div>
      {det?.params.map((p) => (
        <div className="field" key={p.key}>
          <label>
            {p.label} {p.unit ? `(${p.unit})` : ''}
          </label>
          <input className="input" type="number" value={params[p.key] ?? p.default} onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })} />
        </div>
      ))}
      <div className="field">
        <label>UNDA (harakat)</label>
        <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
          {det?.actions.map((a) => (
            <option key={a} value={a}>
              {data.actions.find((x) => x.type === a)?.label ?? a}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Qoida nomi</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Avtomatik nom" />
      </div>
      <div className="row">
        <button className="btn primary" onClick={save}>
          Yaratish
        </button>
      </div>
    </Modal>
  );
}
