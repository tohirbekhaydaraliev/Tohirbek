import { Fragment, useEffect, type ReactNode } from 'react';
import type { Kpi } from '../../shared/types';
import { RISK_LABEL, signedPct, value } from '../lib/format';
import { Sparkline } from './Charts';
import { Icon } from './Icon';

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Yuklanmoqda" />;
}

export function LoadingPage({ text = 'Yuklanmoqda...' }: { text?: string }) {
  return (
    <div className="loading-page">
      <Spinner /> {text}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="notice error">
      <Icon name="alert" />
      <div className="spacer">{error}</div>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          Qayta urinish
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function RiskBadge({ risk }: { risk: string }) {
  return (
    <span className={`badge risk-${risk}`}>
      <span className="dot" />
      {RISK_LABEL[risk] ?? risk}
    </span>
  );
}

const SEV_ICON: Record<string, string> = { critical: 'alert', warning: 'alert', info: 'eye', good: 'check' };
const SEV_LABEL: Record<string, string> = { critical: 'Jiddiy', warning: 'Diqqat', info: "Ma'lumot", good: 'Yaxshi' };

export function SeverityBadge({ severity }: { severity: 'critical' | 'warning' | 'info' | 'good' }) {
  return (
    <span className={`badge sev-${severity === 'info' ? 'good' : severity}`}>
      <Icon name={SEV_ICON[severity]} size={12} stroke={2.2} />
      {SEV_LABEL[severity]}
    </span>
  );
}

/** O'zgarish: rang = yo'nalish × yaxshi/yomon; ikonka + matn (faqat rang emas). */
export function Delta({ change, good, digits = 0 }: { change: number | null; good: 'up' | 'down'; digits?: number }) {
  if (change === null || !Number.isFinite(change)) return <span className="delta neutral">—</span>;
  const tiny = Math.abs(change) < 0.03;
  const better = good === 'up' ? change > 0 : change < 0;
  const cls = tiny ? 'neutral' : better ? 'good' : 'bad';
  return (
    <span className={`delta ${cls}`}>
      {!tiny && <Icon name={change > 0 ? 'up' : 'down'} size={12} stroke={2.4} />}
      {signedPct(change, digits)}
    </span>
  );
}

export function StatTile({ kpi, windowDays }: { kpi: Kpi; windowDays?: number }) {
  const meetsTarget =
    kpi.target !== null && kpi.target !== undefined && kpi.current !== null
      ? kpi.targetComparator === 'lte'
        ? kpi.current <= kpi.target
        : kpi.current >= kpi.target
      : null;
  return (
    <div className="tile">
      <div className="tile-label">{kpi.label}</div>
      <div className="tile-value">{value(kpi.current, kpi.unit)}</div>
      <div className="tile-meta">
        <Delta change={kpi.change} good={kpi.goodDirection} />
        <span>{windowDays ? `oldingi ${windowDays} kunga nisbatan` : 'oldingi davrga nisbatan'}</span>
      </div>
      {kpi.target !== null && kpi.target !== undefined && (
        <div className="tile-meta">
          <span className={`badge ${meetsTarget ? 'good' : 'critical'}`} style={{ padding: '0 7px' }}>
            <span className="dot" />
            Maqsad {kpi.targetComparator === 'lte' ? '≤' : '≥'} {value(kpi.target, kpi.unit)}
          </span>
        </div>
      )}
      {kpi.series && kpi.series.length > 2 && <Sparkline values={kpi.series} />}
    </div>
  );
}

/** Churn ehtimoli metri: to'ldirish xavfni bildiradi, yonida foiz matni. */
export function Meter({ value: v, threshold = 0.6 }: { value: number | null; threshold?: number }) {
  if (v === null) return <span className="muted">—</span>;
  const color = v >= threshold ? 'var(--critical)' : v >= threshold * 0.55 ? 'var(--warning)' : 'var(--good)';
  return (
    <div className="meter">
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${Math.round(v * 100)}%`, background: color }} />
      </div>
      <span className="small tnum strong" style={{ minWidth: 36, textAlign: 'right' }}>
        {Math.round(v * 100)}%
      </span>
    </div>
  );
}

export function Modal({ title, onClose, children, drawer }: { title: ReactNode; onClose: () => void; children: ReactNode; drawer?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={`overlay ${drawer ? '' : 'modal-wrap'}`} onClick={onClose}>
      <div className={drawer ? 'drawer' : 'modal'} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Yopish">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
        <span />
      </span>
      {label && <span className="small">{label}</span>}
    </label>
  );
}

export function Segmented<T extends string | number>({ value: v, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === v ? 'on' : ''} onClick={() => onChange(o.value)} role="tab" aria-selected={o.value === v}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------- Markdown (xavfsiz: faqat React elementlari, innerHTML yo'q) ----------------

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  // Kursiv faqat so'z chegarasida (ANTHROPIC_API_KEY kabi identifikatorlarni buzmaslik uchun)
  const re = /(\*\*[^*]+\*\*|`[^`]+`|(?<![\w])_[^_\n]+?_(?![\w]))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<strong key={i++}>{inline(tok.slice(2, -2))}</strong>);
    else if (tok.startsWith('`')) parts.push(<code key={i++}>{tok.slice(1, -1)}</code>);
    else parts.push(<em key={i++}>{inline(tok.slice(1, -1))}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      blocks.push(<h3 key={key++}>{inline(h[2])}</h3>);
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      blocks.push(
        <div className="table-wrap" key={key++}>
          <table>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{inline(c)}</th> : <td key={ci}>{inline(c)}</td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*•]|\d+[.)])\s|\s*\|)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++}>
        {para.map((p, pi) => (
          <Fragment key={pi}>
            {pi > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
