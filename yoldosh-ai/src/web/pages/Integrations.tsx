import { useRef, useState } from 'react';
import type { ConnectorTypeInfo, ConnectorView } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorNotice, LoadingPage, Modal } from '../components/ui';
import { api, del, getToken, patch, post } from '../lib/api';
import { ago } from '../lib/format';
import { useApi, useApp } from '../lib/hooks';

const CATEGORY: Record<string, string> = { marketing: 'Marketing', sales: 'Sotuv (CRM)', finance: 'Moliya', messaging: 'Aloqa', files: 'Fayllar', demo: 'Demo' };

interface Employee {
  id: string;
  name: string;
  role: string;
  telegram_chat_id: string | null;
  source: string;
}

export function IntegrationsPage() {
  const connectors = useApi<ConnectorView[]>('/api/connectors');
  const catalog = useApi<ConnectorTypeInfo[]>('/api/connectors/catalog');
  const [adding, setAdding] = useState<ConnectorTypeInfo | null>(null);

  if (connectors.error) return <ErrorNotice error={connectors.error} onRetry={connectors.reload} />;
  if (!connectors.data || !catalog.data) return <LoadingPage />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Integratsiyalar</h1>
          <div className="sub">Ma'lumot xodimlardan qayta kiritilmaydi — mavjud tizimlardan API va webhook orqali avtomatik olinadi.</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Ulangan manbalar</h2>
          <span className="hint">har 15 daqiqada sinxronlanadi, webhooklar — real vaqtda</span>
        </div>
        <div className="grid grid-2">
          {connectors.data.map((c) => (
            <ConnectorCard key={c.id} c={c} catalog={catalog.data!} onChange={connectors.reload} />
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Yangi integratsiya qo'shish</h2>
        </div>
        <div className="grid grid-2">
          {catalog.data.map((t) => (
            <div key={t.type} className="action-card">
              <div className="action-head">
                <div>
                  <div className="action-title">{t.label}</div>
                  <span className="badge" style={{ marginTop: 4 }}>
                    {CATEGORY[t.category]}
                  </span>
                </div>
                <button className="btn sm primary" onClick={() => setAdding(t)}>
                  <Icon name="plus" size={14} /> Ulash
                </button>
              </div>
              <div className="small ink2">{t.description}</div>
              <div className="tiny muted">
                {[t.capabilities.sync && 'API sinxronlash', t.capabilities.webhook && 'Webhook', t.capabilities.actions.length && `Harakatlar: ${t.capabilities.actions.length}`].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-2">
        <CsvImport />
        <Employees />
      </div>

      {adding && <AddConnector type={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); connectors.reload(); }} />}
    </div>
  );
}

function ConnectorCard({ c, catalog, onChange }: { c: ConnectorView; catalog: ConnectorTypeInfo[]; onChange: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const def = catalog.find((t) => t.type === c.type);
  const act = async (op: string, fn: () => Promise<any>) => {
    setBusy(op);
    try {
      const res = await fn();
      if (op === 'sync') toast(res.ok ? `Sinxronlandi: ${JSON.stringify(res.stats ?? {})}` : `Xato: ${res.error}`);
      else if (op === 'test') toast(res.ok ? `✓ ${res.message}` : `Xato: ${res.message}`);
      else if (op === 'webhook') toast(`Webhook o'rnatildi: ${res.url}`);
      onChange();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const demo = c.type === 'demo';
  return (
    <div className="action-card">
      <div className="action-head">
        <div>
          <div className="action-title">{c.name}</div>
          <div className="action-meta" style={{ marginTop: 4 }}>
            <span className={`badge ${c.lastError ? 'critical' : c.status === 'active' ? 'good' : 'warning'}`}>
              <span className="dot" />
              {c.lastError ? 'Xato' : c.status === 'active' ? 'Faol' : 'Pauza'}
            </span>
            <span className="badge">{demo ? 'Demo' : def?.label ?? c.type}</span>
            {c.lastSyncAt && <span className="tiny muted">sinxron: {ago(c.lastSyncAt)}</span>}
          </div>
        </div>
      </div>
      {c.lastError && <div className="notice error small">{c.lastError}</div>}
      {c.webhookUrl && (
        <div className="field">
          <label>Webhook manzili</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="copy spacer">{c.webhookUrl}</span>
            <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(c.webhookUrl!).then(() => toast('Nusxa olindi'))} aria-label="Nusxa olish">
              <Icon name="copy" size={14} />
            </button>
          </div>
        </div>
      )}
      {!demo && (
        <div className="row" style={{ gap: 6 }}>
          {def?.capabilities.sync && (
            <button className="btn sm" disabled={!!busy} onClick={() => act('sync', () => post(`/api/connectors/${c.id}/sync`))}>
              <Icon name="refresh" size={14} /> {busy === 'sync' ? 'Sinxronlanmoqda...' : 'Sinxronlash'}
            </button>
          )}
          <button className="btn sm" disabled={!!busy} onClick={() => act('test', () => post(`/api/connectors/${c.id}/test`))}>
            Tekshirish
          </button>
          {c.type === 'telegram' && (
            <button className="btn sm" disabled={!!busy} onClick={() => act('webhook', () => post(`/api/connectors/${c.id}/telegram-webhook`))}>
              <Icon name="link" size={14} /> Webhookni o'rnatish
            </button>
          )}
          <button className="btn ghost sm" disabled={!!busy} onClick={() => act('toggle', () => patch(`/api/connectors/${c.id}`, { status: c.status === 'active' ? 'paused' : 'active' }))}>
            {c.status === 'active' ? 'Pauza' : 'Faollashtirish'}
          </button>
          <button
            className="btn ghost sm danger"
            disabled={!!busy}
            onClick={() => {
              if (confirm(`"${c.name}" integratsiyasini o'chirasizmi?`)) void act('delete', () => del(`/api/connectors/${c.id}`));
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      )}
      {c.lastRun && <div className="tiny muted">Oxirgi ishga tushirish: {c.lastRun.status} · {ago(c.lastRun.startedAt)}</div>}
    </div>
  );
}

function AddConnector({ type, onClose, onSaved }: { type: ConnectorTypeInfo; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(type.configFields.map((f) => [f.key, f.default ?? ''])));
  const [name, setName] = useState(type.label);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const config: Record<string, unknown> = {};
      for (const f of type.configFields) if (values[f.key] !== '') config[f.key] = f.type === 'number' ? Number(values[f.key]) : values[f.key];
      await post('/api/connectors', { type: type.type, name, config });
      toast('Integratsiya ulandi');
      onSaved();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`${type.label} — ulash`} onClose={onClose}>
      <p className="small ink2">{type.description}</p>
      <div className="field">
        <label>Nomi</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {type.configFields.map((f) => (
        <div className="field" key={f.key}>
          <label>
            {f.label}
            {f.required ? ' *' : ''}
          </label>
          {f.type === 'select' ? (
            <select className="select" value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              {f.options?.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
              placeholder={f.placeholder}
              value={values[f.key]}
              autoComplete="off"
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
          {f.help && <span className="help">{f.help}</span>}
        </div>
      ))}
      <div className="tiny muted">Maxfiy maydonlar serverda shifrlangan holda saqlanadi (YOLDOSH_SECRET_KEY) va hech qachon qayta ko'rsatilmaydi.</div>
      <div className="row">
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saqlanmoqda...' : 'Ulash'}
        </button>
      </div>
    </Modal>
  );
}

function CsvImport() {
  const { toast } = useApp();
  const [kind, setKind] = useState<'leads' | 'payments' | 'ad_metrics'>('payments');
  const [result, setResult] = useState<{ imported: number; stats: Record<string, number>; errors: Array<{ row: number; error: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return toast('Faylni tanlang');
    setBusy(true);
    try {
      const text = await f.text();
      setResult(await api(`/api/import/csv?kind=${kind}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' } }));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const template = async () => {
    const res = await fetch(`/api/import/templates/${kind}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${kind}.csv`;
    a.click();
  };
  return (
    <div className="card stack">
      <div>
        <h2>Excel / CSV import</h2>
        <div className="small muted">1C, Excel yoki Google Sheets eksporti. Mijozlar telefon raqami orqali avtomatik birlashtiriladi.</div>
      </div>
      <div className="row">
        <select className="select" style={{ width: 200 }} value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="payments">To'lovlar</option>
          <option value="leads">Leadlar</option>
          <option value="ad_metrics">Reklama xarajatlari</option>
        </select>
        <button className="btn ghost sm" onClick={template}>
          Shablon
        </button>
      </div>
      <input ref={file} type="file" accept=".csv,text/csv" className="small" />
      <div>
        <button className="btn primary sm" onClick={upload} disabled={busy}>
          <Icon name="upload" size={14} /> {busy ? 'Yuklanmoqda...' : 'Import qilish'}
        </button>
      </div>
      {result && (
        <div className="notice small">
          <div>
            {result.imported} ta yozuv import qilindi. {Object.entries(result.stats).map(([k, v]) => `${k}: ${v}`).join(', ')}
            {result.errors.length > 0 && <div style={{ color: 'var(--critical-ink)' }}>Xatolar: {result.errors.slice(0, 5).map((e) => `${e.row}-qator: ${e.error}`).join('; ')}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Employees() {
  const { toast } = useApp();
  const { data, reload } = useApi<Employee[]>('/api/employees');
  const save = async (e: Employee, chatId: string) => {
    await patch(`/api/employees/${e.id}`, { telegram_chat_id: chatId || null });
    toast('Saqlandi');
    reload();
  };
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Xodimlar va Telegram</h2>
          <div className="hint">Xodim botga /start yozib, chat ID'sini oladi — shunda vazifalar unga Telegram'da keladi.</div>
        </div>
      </div>
      {!data ? (
        <LoadingPage />
      ) : data.length === 0 ? (
        <Empty>Xodimlar yo'q</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {data
                .filter((e) => e.role !== 'teacher')
                .map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="small strong">{e.name}</div>
                      <div className="tiny muted">{e.role}</div>
                    </td>
                    <td style={{ width: 170 }}>
                      <input className="input tnum" style={{ padding: '4px 8px' }} placeholder="Telegram chat ID" defaultValue={e.telegram_chat_id ?? ''} onBlur={(ev) => ev.target.value !== (e.telegram_chat_id ?? '') && save(e, ev.target.value)} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
