import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Prefiksli, o'qilishi oson ID: `cus_8k2m...` */
export function newId(prefix: string): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

// --- Vaqt (testlar va demo uchun almashtiriladigan soat) ---
let clockOverride: (() => Date) | null = null;

export function now(): Date {
  return clockOverride ? clockOverride() : new Date();
}

export function setClock(fn: (() => Date) | null): void {
  clockOverride = fn;
}

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * HOUR);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface DateRange {
  start: Date;
  end: Date;
}

/** Oxirgi `days` kun va undan oldingi teng davr. */
export function comparisonRanges(days: number, at: Date = now()): { current: DateRange; previous: DateRange } {
  const end = at;
  const start = addDays(end, -days);
  return {
    current: { start, end },
    previous: { start: addDays(start, -days), end: start },
  };
}

export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

export function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function groupBy<T, K extends string | number>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

// --- Formatlash (AI va xabarlar uchun, o'zbekcha) ---
export function fmtMoney(n: number, currency = "so'm"): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${round(n / 1e9, 2)} mlrd ${currency}`;
  if (abs >= 1e6) return `${round(n / 1e6, 1)} mln ${currency}`;
  return `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ${currency}`;
}

export function fmtPct(n: number | null, digits = 0, signed = true): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const v = round(n * 100, digits);
  return `${signed && v > 0 ? '+' : ''}${v}%`;
}

export function fmtMinutes(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return '—';
  if (min < 90) return `${Math.round(min)} daq`;
  return `${round(min / 60, 1)} soat`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
