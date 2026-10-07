import { createHash } from 'node:crypto';
import type { Db } from '../db';
import { proposeAction, type ProposeInput } from '../actions/service';
import { ACTIONS } from '../actions/registry';
import { loadBrainContext, type BrainContext } from '../brain/context';
import { DETECTORS, type DetectedFinding } from '../brain/detectors';
import { addDays, errorMessage, isoDate, newId } from '../lib/util';

/**
 * Biznes qoidalari: IF <detektor sharti> THEN <harakat>.
 * Masalan: "Lead 2 soatdan ortiq javobsiz bo'lsa → menejerga vazifa".
 * Qoidalar ma'lum vaqt oralig'ida ishga tushadi; bir xil obyekt uchun takroriy
 * harakat yaratilmaydi (yaqinda qamrab olingan obyektlar chiqarib tashlanadi).
 */

export interface BusinessRule {
  id: string;
  name: string;
  description: string | null;
  detector: string;
  params: Record<string, number>;
  action_type: string;
  action_params: Record<string, any>;
  enabled: boolean;
  last_run_at: Date | null;
  last_result: Record<string, unknown> | null;
}

export async function listRules(db: Db, businessId: string): Promise<BusinessRule[]> {
  return db.query<BusinessRule>('SELECT * FROM business_rules WHERE business_id = $1 ORDER BY created_at', [businessId]);
}

export async function upsertRule(
  db: Db,
  businessId: string,
  input: Partial<BusinessRule> & { name: string; detector: string; action_type: string },
): Promise<BusinessRule> {
  const det = DETECTORS[input.detector];
  if (!det) throw new Error(`Noma'lum detektor: ${input.detector}`);
  if (!ACTIONS[input.action_type]) throw new Error(`Noma'lum harakat: ${input.action_type}`);
  if (!det.actions.includes(input.action_type)) throw new Error(`"${det.label}" detektori uchun "${input.action_type}" harakati mos emas`);
  const id = input.id ?? newId('rul');
  await db.query(
    `INSERT INTO business_rules (id, business_id, name, description, detector, params, action_type, action_params, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, detector = EXCLUDED.detector,
       params = EXCLUDED.params, action_type = EXCLUDED.action_type, action_params = EXCLUDED.action_params, enabled = EXCLUDED.enabled`,
    [id, businessId, input.name, input.description ?? null, input.detector, input.params ?? {}, input.action_type, input.action_params ?? {}, input.enabled ?? true],
  );
  return (await db.one<BusinessRule>('SELECT * FROM business_rules WHERE id = $1', [id]))!;
}

export async function deleteRule(db: Db, businessId: string, id: string) {
  await db.query('DELETE FROM business_rules WHERE business_id = $1 AND id = $2', [businessId, id]);
}

const COVERAGE_DAYS: Record<string, number> = { leadIds: 1, customerIds: 7, paymentIds: 5 };

/** Yaqinda shu turdagi harakat bilan qamrab olingan obyektlar. */
async function recentlyCovered(ctx: BrainContext, actionType: string, key: keyof typeof COVERAGE_DAYS): Promise<Set<string>> {
  const rows = await ctx.db.query<{ params: Record<string, any> }>(
    `SELECT params FROM actions WHERE business_id = $1 AND type = $2 AND status NOT IN ('failed', 'rejected') AND created_at > $3`,
    [ctx.businessId, actionType, addDays(ctx.at, -COVERAGE_DAYS[key])],
  );
  return new Set(rows.flatMap((r) => (Array.isArray(r.params?.[key]) ? r.params[key] : [])));
}

const hash = (ids: string[]) => createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 12);

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)}`;
}

async function proposalsFor(ctx: BrainContext, rule: BusinessRule, f: DetectedFinding): Promise<ProposeInput[]> {
  const base = { source: 'rule' as const, ruleId: rule.id, rationale: `Qoida: "${rule.name}". ${f.title}. ${f.summary}` };
  const day = isoDate(ctx.at);
  const out: ProposeInput[] = [];

  const fresh = async (key: keyof typeof COVERAGE_DAYS, ids: string[]) => {
    const covered = await recentlyCovered(ctx, rule.action_type, key);
    return ids.filter((x) => !covered.has(x));
  };

  switch (`${f.detector}:${rule.action_type}`) {
    case 'lead_unanswered:create_task': {
      const byManager = new Map<string, any[]>();
      for (const l of f.items) byManager.set(l.assigned_to ?? '-', [...(byManager.get(l.assigned_to ?? '-') ?? []), l]);
      for (const [managerId, leads] of byManager) {
        const leadIds = await fresh('leadIds', leads.map((l) => l.id));
        if (!leadIds.length) continue;
        const list = leads.filter((l) => leadIds.includes(l.id));
        out.push({
          ...base,
          type: 'create_task',
          title: `${leadIds.length} ta javobsiz lead — ${list[0].manager_name ?? 'biriktirilmagan'}`,
          params: {
            title: `${leadIds.length} ta lead ${rule.params.hours ?? 2}+ soatdan beri javob kutmoqda`,
            description: list.slice(0, 15).map((l) => `• ${l.customer_name ?? 'Mijoz'} ${l.phone ?? ''} — ${l.segment ?? ''}, ${Math.round(l.waiting_minutes / 60)} soat`).join('\n'),
            ...(managerId !== '-' ? { assigneeId: managerId } : {}),
            leadIds,
            dueInHours: 1,
            priority: 'high',
          },
          dedupeKey: `rule:${rule.id}:${managerId}:${hash(leadIds)}`,
        });
      }
      break;
    }
    case 'lead_unanswered:reassign_leads': {
      const leadIds = await fresh('leadIds', f.entityIds);
      if (leadIds.length) out.push({ ...base, type: 'reassign_leads', title: `${leadIds.length} ta javobsiz leadni qayta taqsimlash`, params: { leadIds }, dedupeKey: `rule:${rule.id}:${hash(leadIds)}` });
      break;
    }
    case 'customer_inactive:retention_outreach':
    case 'churn_risk:retention_outreach': {
      const customerIds = await fresh('customerIds', f.entityIds);
      if (customerIds.length) {
        out.push({
          ...base,
          type: 'retention_outreach',
          title: `${customerIds.length} ta mijoz bilan bog'lanish (${f.detector === 'churn_risk' ? 'churn xavfi' : 'faol emas'})`,
          params: { customerIds },
          dedupeKey: `rule:${rule.id}:${hash(customerIds)}`,
        });
      }
      break;
    }
    case 'churn_risk:notify_employee':
    case 'customer_inactive:notify_employee': {
      const customerIds = await fresh('customerIds', f.entityIds);
      if (!customerIds.length) break;
      const lines = f.items
        .filter((s) => customerIds.includes(s.customerId))
        .slice(0, 15)
        .map((s) => `• ${s.name} — ${s.probability !== undefined ? `${Math.round(s.probability * 100)}%` : ''} ${s.reasons?.[0] ?? ''}`);
      out.push({
        ...base,
        type: 'notify_employee',
        title: `Retention: ${customerIds.length} ta xavfli mijoz haqida ogohlantirish`,
        params: {
          role: rule.action_params.role ?? 'retention_manager',
          message: `⚠️ ${f.title}:\n${lines.join('\n')}\n\nIltimos, bugun ular bilan bog'laning.`,
          customerIds,
        },
        dedupeKey: `rule:${rule.id}:${hash(customerIds)}`,
      });
      break;
    }
    case 'cac_above_target:analyze_campaign': {
      const campaignId = (f.metrics as any).campaignId as string;
      out.push({ ...base, type: 'analyze_campaign', title: `${(f.metrics as any).name}: CAC tahlili`, params: { campaignId }, dedupeKey: `rule:${rule.id}:${campaignId}:${isoWeek(ctx.at)}` });
      break;
    }
    case 'group_capacity:route_leads': {
      const item = f.items[0];
      if (item?.alternativeGroupId && item.segment) {
        out.push({
          ...base,
          type: 'route_leads',
          title: `${item.segment}: yangi talabalarni "${item.alternativeName}" guruhiga yo'naltirish`,
          params: { segment: item.segment, fromGroupId: item.group_id, toGroupId: item.alternativeGroupId },
          dedupeKey: `rule:${rule.id}:${item.segment}:${isoWeek(ctx.at)}`,
        });
      }
      break;
    }
    case 'payment_overdue:send_payment_reminder': {
      const paymentIds = await fresh('paymentIds', f.entityIds);
      if (paymentIds.length) {
        const ids = paymentIds.slice(0, 100);
        out.push({ ...base, type: 'send_payment_reminder', title: `${ids.length} ta kechikkan to'lov bo'yicha eslatma`, params: { paymentIds: ids }, dedupeKey: `rule:${rule.id}:${hash(ids)}` });
      }
      break;
    }
    case 'payment_overdue:create_task':
    case 'response_time_sla:create_task':
    case 'customer_inactive:create_task':
    case 'churn_risk:create_task': {
      out.push({
        ...base,
        type: 'create_task',
        title: f.title,
        params: { title: f.title, description: f.summary, priority: f.severity === 'critical' ? 'high' : 'normal', dueInHours: 24, ...(rule.action_params.assigneeId ? { assigneeId: rule.action_params.assigneeId } : {}) },
        dedupeKey: `rule:${rule.id}:${f.dedupeKey}:${day}`,
      });
      break;
    }
    default: {
      // Umumiy: mas'ul xodimga (yoki rahbarga) ogohlantirish
      out.push({
        ...base,
        type: 'notify_employee',
        title: `Ogohlantirish: ${f.title}`,
        params: { role: rule.action_params.role ?? 'owner', message: `⚠️ ${f.title}\n${f.summary}` },
        dedupeKey: `rule:${rule.id}:${f.dedupeKey}:${day}`,
      });
    }
  }
  return out;
}

export interface RulesRunResult {
  ruleId: string;
  name: string;
  findings: number;
  proposed: number;
  executed: number;
  pending: number;
  errors: string[];
}

export async function runRules(db: Db, businessId: string): Promise<RulesRunResult[]> {
  const ctx = await loadBrainContext(db, businessId);
  const rules = (await listRules(db, businessId)).filter((r) => r.enabled);
  const results: RulesRunResult[] = [];
  for (const rule of rules) {
    const res: RulesRunResult = { ruleId: rule.id, name: rule.name, findings: 0, proposed: 0, executed: 0, pending: 0, errors: [] };
    try {
      const det = DETECTORS[rule.detector];
      if (!det) throw new Error(`Noma'lum detektor: ${rule.detector}`);
      const findings = await det.run(ctx, rule.params ?? {});
      res.findings = findings.length;
      for (const f of findings) {
        for (const p of await proposalsFor(ctx, rule, f)) {
          try {
            const r = await proposeAction(db, businessId, p);
            if (!r.created) continue;
            res.proposed++;
            if (r.action.status === 'executed') res.executed++;
            if (r.action.status === 'proposed') res.pending++;
          } catch (err) {
            res.errors.push(errorMessage(err));
          }
        }
      }
    } catch (err) {
      res.errors.push(errorMessage(err));
    }
    await db.query('UPDATE business_rules SET last_run_at = $2, last_result = $3 WHERE id = $1', [rule.id, ctx.at, res]);
    results.push(res);
  }
  return results;
}
