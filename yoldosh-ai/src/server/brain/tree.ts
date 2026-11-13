import type { TreeNode, Unit } from '../../shared/types';
import { pctChange } from '../lib/util';

/**
 * KPI daraxti yordamchilari.
 *
 * Ko'paytma munosabatlari (Daromad = Mijozlar × O'rtacha to'lov, Sotuv = Lead × Konversiya)
 * uchun o'zgarish logarifmik dekompozitsiya orqali omillarga taqsimlanadi:
 *   hissa_i = Δ × ln(x_i1 / x_i0) / ln(V1 / V0)
 * Bu usul tartibga bog'liq emas va hissalar yig'indisi aynan Δ ga teng.
 */

export type Good = 'up' | 'down';

export function nodeStatus(change: number | null, good: Good): TreeNode['status'] {
  if (change === null) return 'ok';
  const adverse = good === 'up' ? -change : change;
  if (adverse >= 0.2) return 'critical';
  if (adverse >= 0.07) return 'warning';
  if (adverse <= -0.07) return 'improved';
  return 'ok';
}

export function makeNode(
  key: string,
  label: string,
  unit: Unit,
  current: number,
  previous: number,
  relation: TreeNode['relation'],
  good: Good = 'up',
  extra: Partial<TreeNode> = {},
): TreeNode {
  const change = pctChange(current, previous);
  return {
    key,
    label,
    unit,
    current,
    previous,
    change,
    contribution: null,
    share: null,
    relation,
    status: nodeStatus(change, good),
    children: [],
    ...extra,
  };
}

/** Ko'paytma omillari bo'yicha hissalar (ota birligida). */
export function productContributions(
  parent: { current: number; previous: number },
  factors: Array<{ current: number; previous: number }>,
): number[] {
  const delta = parent.current - parent.previous;
  const allPositive = parent.current > 0 && parent.previous > 0 && factors.every((f) => f.current > 0 && f.previous > 0);
  if (allPositive && parent.current !== parent.previous) {
    const denom = Math.log(parent.current / parent.previous);
    return factors.map((f) => (delta * Math.log(f.current / f.previous)) / denom);
  }
  // Zaxira: ketma-ket almashtirish usuli
  const out: number[] = [];
  let acc = factors.map((f) => f.previous);
  const prod = (xs: number[]) => xs.reduce((a, b) => a * b, 1);
  for (let i = 0; i < factors.length; i++) {
    const before = prod(acc);
    acc = acc.map((x, j) => (j === i ? factors[i].current : x));
    out.push(prod(acc) - before);
  }
  return out;
}

/** Ota tugunning o'zgarishiga nisbatan ulush (0..1, salbiy bo'lishi mumkin). */
export function attachContribution(parent: TreeNode, child: TreeNode, contribution: number): TreeNode {
  const delta = parent.current - parent.previous;
  child.contribution = contribution;
  child.share = delta !== 0 ? contribution / delta : null;
  return child;
}

/** Tugunning "yomon" tomonga hissasi (musbat = salbiy ta'sir). good='up' bo'lsa — kamayish yomon. */
export function adverseContribution(child: TreeNode, parentGood: Good): number {
  if (child.contribution === null) return 0;
  return parentGood === 'up' ? -child.contribution : child.contribution;
}

export function findNode(root: TreeNode, key: string): TreeNode | null {
  if (root.key === key) return root;
  for (const c of root.children) {
    const f = findNode(c, key);
    if (f) return f;
  }
  return null;
}

export function markPath(root: TreeNode, path: string[]): void {
  const set = new Set(path);
  const walk = (n: TreeNode) => {
    if (set.has(n.key)) n.onPath = true;
    n.children.forEach(walk);
  };
  walk(root);
}
