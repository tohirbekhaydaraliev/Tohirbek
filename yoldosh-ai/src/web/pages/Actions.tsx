import { useState } from 'react';
import type { ActionView } from '../../shared/types';
import { ActionCard } from '../components/ActionCard';
import { Empty, ErrorNotice, LoadingPage, Segmented } from '../components/ui';
import { ago, date } from '../lib/format';
import { useApi } from '../lib/hooks';

type Tab = 'pending' | 'history' | 'tasks' | 'notifications';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_by: string;
  due_at: string | null;
  created_at: string;
  assignee: string | null;
}

interface Notification {
  id: string;
  channel: string;
  recipient: string | null;
  text: string;
  status: string;
  error: string | null;
  created_at: string;
}

export function ActionsPage() {
  const [tab, setTab] = useState<Tab>('pending');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Harakatlar</h1>
          <div className="sub">Action Layer: past xavfli harakatlarni AI o'zi bajaradi, o'rta va yuqori xavflilari sizning tasdig'ingizni kutadi.</div>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pending', label: 'Tasdiq kutmoqda' },
            { value: 'history', label: 'Tarix' },
            { value: 'tasks', label: 'Vazifalar' },
            { value: 'notifications', label: 'Xabarlar' },
          ]}
        />
      </div>
      {tab === 'pending' && <ActionList status="pending" />}
      {tab === 'history' && <ActionList status="history" />}
      {tab === 'tasks' && <Tasks />}
      {tab === 'notifications' && <Notifications />}
    </div>
  );
}

function ActionList({ status }: { status: 'pending' | 'history' }) {
  const { data, error, reload, setData } = useApi<ActionView[]>(`/api/actions?status=${status}&limit=100`, [status]);
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;
  if (!data.length) return <Empty>{status === 'pending' ? "Tasdiq kutayotgan harakat yo'q — hammasi nazoratda." : "Hali harakatlar yo'q."}</Empty>;
  const update = (a: ActionView) => setData(status === 'pending' ? data.filter((x) => x.id !== a.id || a.status === 'proposed') : data.map((x) => (x.id === a.id ? a : x)));
  return (
    <div className="grid grid-2">
      {data.map((a) => (
        <ActionCard key={a.id} action={a} onChange={update} />
      ))}
    </div>
  );
}

function Tasks() {
  const { data, error, reload } = useApi<Task[]>('/api/tasks');
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Vazifalar</h2>
        <span className="hint">AI va qoidalar yaratgan vazifalar (amoCRM ulangan bo'lsa, CRM'da ham)</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Vazifa</th>
              <th>Mas'ul</th>
              <th>Muddat</th>
              <th>Holat</th>
              <th>Manba</th>
            </tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="strong small">{t.title}</div>
                  {t.description && (
                    <div className="tiny muted" style={{ whiteSpace: 'pre-wrap', maxWidth: 520 }}>
                      {t.description.slice(0, 220)}
                      {t.description.length > 220 ? '…' : ''}
                    </div>
                  )}
                </td>
                <td className="small nowrap">{t.assignee ?? '—'}</td>
                <td className="small nowrap">{date(t.due_at, true)}</td>
                <td>
                  <span className={`badge ${t.status === 'open' ? 'warning' : 'good'}`}>
                    <span className="dot" />
                    {t.status === 'open' ? 'Ochiq' : 'Bajarilgan'}
                  </span>
                </td>
                <td className="small muted">{t.created_by === 'ai' ? 'AI' : t.created_by === 'rule' ? 'Qoida' : 'Inson'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Notifications() {
  const { data, error, reload } = useApi<Notification[]>('/api/notifications');
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Yuborilgan xabarlar</h2>
        <span className="hint">Telegram ulanmagan bo'lsa, xabarlar shu yerda ichki jurnal sifatida saqlanadi</span>
      </div>
      {data.length === 0 ? (
        <Empty>Xabarlar yo'q</Empty>
      ) : (
        <div className="stack" style={{ gap: 0 }}>
          {data.map((n) => (
            <div key={n.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="strong small">{n.recipient ?? '—'}</span>
                <span className={`badge ${n.status === 'sent' ? 'good' : n.status === 'failed' ? 'critical' : 'info'}`}>
                  <span className="dot" />
                  {n.channel === 'telegram' ? 'Telegram' : 'Ichki'} · {n.status === 'sent' ? 'yuborildi' : n.status === 'failed' ? 'xato' : 'saqlandi'}
                </span>
                <span className="spacer" />
                <span className="tiny muted">{ago(n.created_at)}</span>
              </div>
              <div className="small ink2" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                {n.text}
              </div>
              {n.error && <div className="tiny" style={{ color: 'var(--critical-ink)' }}>{n.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
