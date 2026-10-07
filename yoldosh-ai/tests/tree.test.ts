import { describe, expect, it } from 'vitest';
import { makeNode, nodeStatus, productContributions } from '../src/server/brain/tree';
import { verdictFor } from '../src/server/feedback/outcomes';
import { churnProbability } from '../src/server/brain/scoring';
import { decidePolicy } from '../src/server/actions/policy';
import { DEFAULT_SETTINGS } from '../src/shared/types';

describe('KPI daraxti matematikasi', () => {
  it("log-dekompozitsiya hissalari yig'indisi ota o'zgarishiga teng", () => {
    // Daromad = Mijozlar × O'rtacha chek: 100×2000 → 80×2200
    const parent = { current: 80 * 2200, previous: 100 * 2000 };
    const [a, b] = productContributions(parent, [
      { current: 80, previous: 100 },
      { current: 2200, previous: 2000 },
    ]);
    expect(a + b).toBeCloseTo(parent.current - parent.previous, 6);
    expect(a).toBeLessThan(0); // mijozlar kamaygan — salbiy hissa
    expect(b).toBeGreaterThan(0); // chek oshgan — musbat hissa
  });

  it("nol qiymatlarda zaxira (ketma-ket almashtirish) usuli ishlaydi", () => {
    const parent = { current: 50, previous: 0 };
    const parts = productContributions(parent, [
      { current: 5, previous: 0 },
      { current: 10, previous: 10 },
    ]);
    expect(parts.reduce((x, y) => x + y, 0)).toBeCloseTo(50);
  });

  it('holat yaxshi/yomon yo‘nalishga bog‘liq', () => {
    expect(nodeStatus(-0.25, 'up')).toBe('critical');
    expect(nodeStatus(-0.1, 'up')).toBe('warning');
    expect(nodeStatus(0.1, 'up')).toBe('improved');
    expect(nodeStatus(3.4, 'down')).toBe('critical'); // javob vaqti 4 baravar oshdi
    expect(makeNode('x', 'X', 'count', 10, 10, 'sum').status).toBe('ok');
  });
});

describe('feedback verdikti', () => {
  it('ulushlar uchun 5 p.p., boshqalar uchun 5% chegarasi', () => {
    expect(verdictFor(0, 0.93, 'increase', 'ratio')).toBe('improved');
    expect(verdictFor(0.5, 0.52, 'increase', 'ratio')).toBe('no_change');
    expect(verdictFor(64000, 82000, 'decrease', 'money')).toBe('worsened');
    expect(verdictFor(71000, 66800, 'decrease', 'money')).toBe('improved');
    expect(verdictFor(null, 5, 'increase', 'count')).toBe('unknown');
  });
});

describe('churn skoring', () => {
  it("davomati tushgan va to'lovi kechikkan mijoz — yuqori xavf, sabablar bilan", () => {
    const risky = churnProbability({ attendance14: 0.1, attendancePrev: 0.9, daysSinceLastPresent: 10, overdueDays: 6, tenureMonths: 3 });
    const healthy = churnProbability({ attendance14: 0.9, attendancePrev: 0.88, daysSinceLastPresent: 1, overdueDays: null, tenureMonths: 8 });
    expect(risky.probability).toBeGreaterThan(0.8);
    expect(healthy.probability).toBeLessThan(0.15);
    expect(risky.reasons.join(' ')).toMatch(/davomat/i);
    expect(risky.reasons.join(' ')).toMatch(/kechikkan/);
  });
});

describe('human-in-the-loop siyosati', () => {
  it('yuqori xavf har doim tasdiq talab qiladi', () => {
    const s = { ...DEFAULT_SETTINGS, autonomy: { low: 'auto', medium: 'auto', high: 'approval' } as const };
    expect(decidePolicy('high', s, 'rule')).toBe('approval');
    expect(decidePolicy('medium', s, 'rule')).toBe('auto');
    expect(decidePolicy('medium', DEFAULT_SETTINGS, 'diagnosis')).toBe('approval');
    expect(decidePolicy('low', DEFAULT_SETTINGS, 'rule')).toBe('auto');
    expect(decidePolicy('low', { ...DEFAULT_SETTINGS, agentLowRiskAuto: false }, 'agent')).toBe('approval');
  });
});
