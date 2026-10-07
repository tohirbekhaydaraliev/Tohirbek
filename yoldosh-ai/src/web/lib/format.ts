import type { Unit } from '../../shared/types';

/** O'zbekcha formatlash yordamchilari. */

const nf = new Intl.NumberFormat('ru-RU');

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return nf.format(Number(n.toFixed(digits))).replace(/ /g, ' ');
}

/** 638 300 000 → "638,3 mln so'm" */
export function money(n: number | null | undefined, opts: { short?: boolean; unit?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const unit = opts.unit === false ? '' : " so'm";
  const abs = Math.abs(n);
  if (opts.short !== false) {
    if (abs >= 1e9) return `${num(n / 1e9, 2)} mlrd${unit}`;
    if (abs >= 1e6) return `${num(n / 1e6, 1)} mln${unit}`;
    if (abs >= 1e4) return `${num(n / 1e3, 0)} ming${unit}`;
  }
  return `${num(n)}${unit}`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${num(n * 100, digits)}%`;
}

export function signedPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const v = Number((n * 100).toFixed(digits));
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), digits)}%`;
}

export function minutes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 90) return `${Math.round(n)} daq`;
  if (n < 60 * 48) return `${num(n / 60, 1)} soat`;
  return `${num(n / 1440, 1)} kun`;
}

export function value(n: number | null | undefined, unit: Unit): string {
  switch (unit) {
    case 'money':
      return money(n);
    case 'ratio':
    case 'percent':
      return pct(n);
    case 'minutes':
      return minutes(n);
    case 'months':
      return n === null || n === undefined ? '—' : `${num(n, 1)} oy`;
    default:
      return num(n);
  }
}

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

export function date(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const base = `${d.getDate()}-${MONTHS[d.getMonth()]}`;
  if (!withTime) return base;
  return `${base}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${d}-${MONTHS[m - 1]?.slice(0, 3)}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'hozirgina';
  if (diff < 3600) return `${Math.floor(diff / 60)} daq oldin`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} soat oldin`;
  return `${Math.floor(diff / 86400)} kun oldin`;
}

export const SOURCE_LABEL: Record<string, string> = {
  rule: 'Qoida',
  diagnosis: 'Diagnostika',
  agent: 'AI agent',
  user: 'Foydalanuvchi',
};

export const RISK_LABEL: Record<string, string> = { low: 'Past xavf', medium: "O'rta xavf", high: 'Yuqori xavf' };

export const STATUS_LABEL: Record<string, string> = {
  proposed: 'Tasdiq kutmoqda',
  approved: 'Tasdiqlandi',
  executing: 'Bajarilmoqda',
  executed: 'Bajarildi',
  rejected: 'Rad etildi',
  ignored: "E'tiborsiz",
  failed: 'Xato',
};

export const VERDICT_LABEL: Record<string, string> = {
  pending: 'Natija kutilmoqda',
  improved: 'Yaxshilandi',
  no_change: "O'zgarmadi",
  worsened: 'Yomonlashdi',
  unknown: "Noma'lum",
};
