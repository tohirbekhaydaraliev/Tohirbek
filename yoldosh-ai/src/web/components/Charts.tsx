import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shortDate } from '../lib/format';

/**
 * Yengil SVG grafiklar (kutubxonasiz):
 * - ingichka marklar (2px chiziq, ≤24px barlar, 4px yumaloq uchlar)
 * - ranglar CSS tokenlardan (light/dark avtomatik)
 * - hover: chiziqda crosshair + tooltip, barlarda har bir mark o'z tooltip'i
 * - matn hech qachon seriya rangida emas
 */

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(ref.current);
    setWidth(ref.current.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Stat tile ichidagi trend (hover'siz bezak emas — qiymatlar tile'da yozilgan). */
export function Sparkline({ values, height = 34 }: { values: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const path = useMemo(() => {
    if (!width || values.length < 2) return null;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const pad = 3;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * width, pad + (1 - (v - min) / span) * (height - pad * 2)] as const);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const area = `${line}L${width},${height}L0,${height}Z`;
    return { line, area, last: pts[pts.length - 1] };
  }, [values, width, height]);
  return (
    <div ref={ref} className="chart" style={{ height }}>
      {path && (
        <svg width={width} height={height} role="img" aria-label="Trend">
          <path d={path.area} fill="var(--viz-area)" />
          <path d={path.line} fill="none" stroke="var(--viz-cur)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={path.last[0]} cy={path.last[1]} r={3.5} fill="var(--viz-cur)" stroke="var(--surface)" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}

export interface SeriesPoint {
  date: string;
  value: number;
}

/** Bitta seriyali vaqt grafigi: crosshair eng yaqin kunga yopishadi, tooltip qiymatni ko'rsatadi. */
export function LineChart({
  data,
  height = 180,
  format = (v: number) => String(Math.round(v)),
  label,
}: {
  data: SeriesPoint[];
  height?: number;
  format?: (v: number) => string;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 10, right: 12, bottom: 24, left: 44 };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const x = (i: number) => m.left + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => m.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
  const area = data.length ? `${line}L${x(data.length - 1)},${y(0)}L${x(0)},${y(0)}Z` : '';
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 70))));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round((px / rect.width) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };

  return (
    <div ref={ref} className="chart" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
              <text x={m.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tnum">
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % labelEvery === 0 || i === data.length - 1 ? (
              <text key={d.date} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--muted)">
                {shortDate(d.date)}
              </text>
            ) : null,
          )}
          <path d={area} fill="var(--viz-area)" />
          <path d={line} fill="none" stroke="var(--viz-cur)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && data[hover] && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + innerH} stroke="var(--axis)" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(data[hover].value)} r={4.5} fill="var(--viz-cur)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
          <rect
            x={m.left}
            y={m.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div className="chart-tooltip" style={{ left: x(hover), top: y(data[hover].value) }}>
          <div className="tt-value">{format(data[hover].value)}</div>
          <div className="tt-label">
            {label} · {shortDate(data[hover].date)}
          </div>
        </div>
      )}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  current: number;
  previous?: number | null;
  display: string;
  tooltip?: string;
}

/** Gorizontal barlar: joriy davr (to'q) va oldingi davr (och) — bitta tusning ikki pog'onasi. */
export function BarList({
  rows,
  showPrevious = true,
  reference,
}: {
  rows: BarRow[];
  showPrevious?: boolean;
  reference?: { value: number; label: string };
}) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string; sub: string } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...rows.flatMap((r) => [r.current, r.previous ?? 0]), reference?.value ?? 0) * 1.05;
  const show = (e: React.PointerEvent | React.FocusEvent, text: string, sub: string) => {
    const host = wrap.current?.getBoundingClientRect();
    const el = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!host) return;
    setTip({ x: el.left - host.left + el.width / 2, y: el.top - host.top, text, sub });
  };
  return (
    <div className="chart" ref={wrap}>
      <div className="barlist">
        {rows.map((r) => (
          <div className="barlist-row" key={r.key}>
            <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.label}
            </div>
            <div className="barlist-bars" style={{ position: 'relative' }}>
              <div
                className="barlist-bar"
                tabIndex={0}
                style={{ width: `${(r.current / max) * 100}%`, background: 'var(--viz-cur)' }}
                onPointerMove={(e) => show(e, r.display, `Joriy davr${r.tooltip ? ` · ${r.tooltip}` : ''}`)}
                onFocus={(e) => show(e, r.display, 'Joriy davr')}
                onPointerLeave={() => setTip(null)}
                onBlur={() => setTip(null)}
              />
              {showPrevious && r.previous !== undefined && r.previous !== null && (
                <div
                  className="barlist-bar"
                  tabIndex={0}
                  style={{ width: `${(r.previous / max) * 100}%`, background: 'var(--viz-prev)' }}
                  onPointerMove={(e) => show(e, String(r.previous), 'Oldingi davr')}
                  onFocus={(e) => show(e, String(r.previous), 'Oldingi davr')}
                  onPointerLeave={() => setTip(null)}
                  onBlur={() => setTip(null)}
                />
              )}
              {reference && (
                <div
                  title={reference.label}
                  style={{ position: 'absolute', left: `${(reference.value / max) * 100}%`, top: -3, bottom: -3, width: 1, background: 'var(--ink-3)' }}
                />
              )}
            </div>
            <div className="small tnum" style={{ textAlign: 'right' }}>
              {r.display}
            </div>
          </div>
        ))}
      </div>
      {tip && (
        <div className="chart-tooltip" style={{ left: tip.x, top: tip.y }}>
          <div className="tt-value">{tip.text}</div>
          <div className="tt-label">{tip.sub}</div>
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string; line?: boolean }> }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span className="legend-item" key={i.label}>
          <span className="legend-swatch" style={{ background: i.color, height: i.line ? 2 : 10, borderRadius: i.line ? 1 : 3 }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Ustunli grafik (bitta seriya), qiymat ustun tepasida. */
export function Columns({ data, height = 170, label }: { data: Array<{ key: string; label: string; value: number; display: string; sub?: string }>; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 22, bottom: 34, left: 4, right: 4 };
  const innerH = height - m.top - m.bottom;
  const band = data.length ? (width - m.left - m.right) / data.length : 0;
  const barW = Math.min(24 * 1.6, band * 0.55);
  const max = Math.max(1e-9, ...data.map((d) => d.value)) * 1.08;
  return (
    <div ref={ref} className="chart" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          <line x1={m.left} x2={width - m.right} y1={m.top + innerH} y2={m.top + innerH} stroke="var(--axis)" />
          {data.map((d, i) => {
            const h = (d.value / max) * innerH;
            const cx = m.left + band * i + band / 2;
            const yTop = m.top + innerH - h;
            const r = Math.min(4, h / 2);
            const x0 = cx - barW / 2;
            const path = h > 0 ? `M${x0},${m.top + innerH}V${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}H${x0 + barW - r}Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r}V${m.top + innerH}Z` : '';
            return (
              <g key={d.key} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <rect x={m.left + band * i} y={m.top} width={band} height={innerH} fill="transparent" />
                <path d={path} fill="var(--viz-cur)" opacity={hover === null || hover === i ? 1 : 0.6} />
                <text x={cx} y={yTop - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--ink)" className="tnum">
                  {d.display}
                </text>
                <text x={cx} y={height - 16} textAnchor="middle" fontSize={11.5} fill="var(--ink-2)">
                  {d.label}
                </text>
                {d.sub && (
                  <text x={cx} y={height - 3} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
                    {d.sub}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
