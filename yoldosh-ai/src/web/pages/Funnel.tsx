import { useState } from 'react';
import { BarList, Columns, Legend, LineChart } from '../components/Charts';
import { Delta, ErrorNotice, LoadingPage, Segmented } from '../components/ui';
import { minutes, money, num, pct } from '../lib/format';
import { useApi } from '../lib/hooks';

interface FunnelRow {
  segment: string;
  leads: number;
  responded: number;
  trials: number;
  won: number;
  conversion: number;
  trialRate: number;
}

interface FunnelData {
  campaigns: Array<{
    campaign_id: string;
    name: string;
    source: string;
    segment: string | null;
    status: string;
    spend: number;
    platform_leads: number;
    crm_leads: number;
    won: number;
    revenue: number;
    cpl: number;
    cac: number | null;
    roas: number | null;
    prev: { spend: number; cpl: number; cac: number | null; won: number } | null;
  }>;
  funnel: { current: FunnelRow[]; previous: FunnelRow[] };
  marketing: { current: { spend: number; cac: number | null; platformLeads: number }; previous: { spend: number; cac: number | null } };
  revenue: { current: { total: number; newRevenue: number }; previous: { total: number; newRevenue: number } };
  responseTimes: Array<{ key: string; label: string; medianMinutes: number | null; withinSlaShare: number; leads: number; prev: { medianMinutes: number | null } | null }>;
  managers: Array<{ employee_id: string; name: string; leads: number; won: number; conversion: number; median_minutes: number | null; open_unanswered: number }>;
  series: { spend: Array<{ date: string; value: number }>; leads: Array<{ date: string; value: number }>; won: Array<{ date: string; value: number }> };
}

const SOURCE: Record<string, string> = { meta_ads: 'Meta', telegram_ads: 'Telegram Ads', google_ads: 'Google', csv_import: 'CSV' };

export function FunnelPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<FunnelData>(`/api/funnel?days=${days}`, [days]);
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;

  const total = data.funnel.current.find((f) => f.segment === 'Jami')!;
  const totalPrev = data.funnel.previous.find((f) => f.segment === 'Jami');
  const segments = data.funnel.current.filter((f) => f.segment !== 'Jami');
  const prevSeg = (s: string) => data.funnel.previous.find((f) => f.segment === s);
  const cac = data.marketing.current.cac;

  return (
    <div className={`page ${loading ? 'fade' : ''}`}>
      <div className="page-head">
        <div>
          <h1>Voronka: Marketing → Lead → Sotuv → Daromad</h1>
          <div className="sub">Reklama kabinetlari, CRM va to'lov tizimlaridan avtomatik yig'ilgan yagona ko'rinish</div>
        </div>
        <Segmented
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: '7 kun' },
            { value: 30, label: '30 kun' },
            { value: 90, label: '90 kun' },
          ]}
        />
      </div>

      <div className="card">
        <div className="flow">
          <div className="flow-step">
            <span className="tile-label">Reklama xarajati</span>
            <span className="flow-value">{money(data.marketing.current.spend)}</span>
            <Delta change={data.marketing.previous.spend ? data.marketing.current.spend / data.marketing.previous.spend - 1 : null} good="down" />
          </div>
          <div className="flow-step">
            <span className="tile-label">Leadlar</span>
            <span className="flow-value">{num(total.leads)}</span>
            <span className="flow-rate">CPL {money(data.marketing.current.platformLeads ? data.marketing.current.spend / data.marketing.current.platformLeads : null)}</span>
          </div>
          <div className="flow-step">
            <span className="tile-label">Sinov darsi</span>
            <span className="flow-value">{num(total.trials)}</span>
            <span className="flow-rate">{pct(total.trialRate)} leadlardan</span>
          </div>
          <div className="flow-step">
            <span className="tile-label">Sotuvlar</span>
            <span className="flow-value">{num(total.won)}</span>
            <span className="flow-rate">
              konversiya {pct(total.conversion)} {totalPrev && <Delta change={totalPrev.conversion ? total.conversion / totalPrev.conversion - 1 : null} good="up" />}
            </span>
          </div>
          <div className="flow-step">
            <span className="tile-label">Yangi mijozlar daromadi</span>
            <span className="flow-value">{money(data.revenue.current.newRevenue)}</span>
            <span className="flow-rate">CAC {money(cac)}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Kunlik leadlar</h2>
          </div>
          <LineChart data={data.series.leads} label="Leadlar" format={(v) => num(v)} />
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Kunlik sotuvlar</h2>
          </div>
          <LineChart data={data.series.won} label="Sotuvlar" format={(v) => num(v)} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Kampaniyalar</h2>
          <span className="hint">CAC o'zgarishi oldingi davrga nisbatan</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Kampaniya</th>
                <th>Manba</th>
                <th className="num">Xarajat</th>
                <th className="num">Leadlar</th>
                <th className="num">CPL</th>
                <th className="num">Sotuvlar</th>
                <th className="num">CAC</th>
                <th className="num">O'zgarish</th>
                <th className="num">ROAS</th>
              </tr>
            </thead>
            <tbody>
              {data.campaigns
                .filter((c) => c.spend > 0 || c.won > 0)
                .map((c) => (
                  <tr key={c.campaign_id}>
                    <td>
                      <div className="small strong">{c.name}</div>
                      <div className="tiny muted">
                        {c.segment ?? '—'} · {c.status === 'active' ? 'faol' : c.status}
                      </div>
                    </td>
                    <td className="small">{SOURCE[c.source] ?? c.source}</td>
                    <td className="num small">{money(c.spend)}</td>
                    <td className="num small">{num(c.platform_leads || c.crm_leads)}</td>
                    <td className="num small">{money(c.cpl)}</td>
                    <td className="num small">{num(c.won)}</td>
                    <td className="num small strong">{money(c.cac)}</td>
                    <td className="num">{c.prev?.cac && c.cac ? <Delta change={c.cac / c.prev.cac - 1} good="down" /> : '—'}</td>
                    <td className="num small">{c.roas !== null ? `${num(c.roas, 1)}×` : '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Segmentlar bo'yicha konversiya</h2>
            <Legend
              items={[
                { label: 'Joriy davr', color: 'var(--viz-cur)' },
                { label: 'Oldingi davr', color: 'var(--viz-prev)' },
              ]}
            />
          </div>
          <BarList
            rows={segments.map((s) => ({
              key: s.segment,
              label: s.segment,
              current: s.conversion * 100,
              previous: (prevSeg(s.segment)?.conversion ?? 0) * 100,
              display: pct(s.conversion),
              tooltip: `${s.leads} lead → ${s.won} sotuv`,
            }))}
          />
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Birinchi javob vaqti (median)</h2>
            <Legend
              items={[
                { label: 'Joriy davr', color: 'var(--viz-cur)' },
                { label: 'Oldingi davr', color: 'var(--viz-prev)' },
              ]}
            />
          </div>
          <BarList
            rows={data.responseTimes.map((r) => ({
              key: r.key,
              label: r.label,
              current: r.medianMinutes ?? 0,
              previous: r.prev?.medianMinutes ?? 0,
              display: minutes(r.medianMinutes),
              tooltip: `SLA ichida ${pct(r.withinSlaShare, 0)}`,
            }))}
          />
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Sotuv menejerlari</h2>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Menejer</th>
                  <th className="num">Leadlar</th>
                  <th className="num">Sotuv</th>
                  <th className="num">Konversiya</th>
                  <th className="num">Javob (median)</th>
                  <th className="num">Javobsiz</th>
                </tr>
              </thead>
              <tbody>
                {data.managers.map((m) => (
                  <tr key={m.employee_id}>
                    <td className="small strong">{m.name}</td>
                    <td className="num small">{num(m.leads)}</td>
                    <td className="num small">{num(m.won)}</td>
                    <td className="num small">{pct(m.conversion)}</td>
                    <td className="num small">{minutes(m.median_minutes)}</td>
                    <td className="num small">{m.open_unanswered > 0 ? <span className="badge critical"><span className="dot" />{m.open_unanswered}</span> : '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Voronka segmentlar bo'yicha</h2>
          </div>
          <Columns
            label="Sotuvlar segmentlar bo'yicha"
            data={segments.map((s) => ({ key: s.segment, label: s.segment, value: s.won, display: num(s.won), sub: `${num(s.leads)} lead` }))}
          />
        </div>
      </div>
    </div>
  );
}
