import type { Db } from '../db';
import type { Business } from '../../shared/types';
import { getBusiness } from '../context/business';
import { listTargets, type Target } from '../context/targets';
import { now } from '../lib/util';

/** Brain modullari uchun umumiy kontekst: biznes, maqsadlar, vaqt. */
export interface BrainContext {
  db: Db;
  businessId: string;
  business: Business;
  targets: Target[];
  at: Date;
}

export async function loadBrainContext(db: Db, businessId: string, at: Date = now()): Promise<BrainContext> {
  const [business, targets] = await Promise.all([getBusiness(db, businessId), listTargets(db, businessId)]);
  return { db, businessId, business, targets, at };
}

export function targetFor(ctx: BrainContext, metric: string, segment?: string | null): Target | null {
  return (
    ctx.targets.find((t) => t.metric === metric && t.segment === (segment ?? null)) ??
    ctx.targets.find((t) => t.metric === metric && t.segment === null) ??
    null
  );
}
