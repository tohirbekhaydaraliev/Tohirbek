import type { Db } from '../db';
import { insertMany } from '../db';
import type { Business } from '../../shared/types';
import { UserError } from '../lib/errors';
import { newId } from '../lib/util';
import { createBusiness, getBusiness, updateBusiness } from './business';
import { upsertProduct } from './products';

/**
 * Yangi (haqiqiy) biznesni ishga tushirish: profil, mahsulotlar/kurslar,
 * standart biznes qoidalari va javob SLA'si. Ma'lumotlar keyin integratsiyalardan keladi.
 */

export const VERTICALS = ['education', 'retail', 'services', 'other'] as const;
export type Vertical = (typeof VERTICALS)[number];

export function defaultRules(vertical: string) {
  const who = vertical === 'education' ? 'Talaba' : 'Mijoz';
  const unit = vertical === 'education' ? 'Guruh' : "Sig'im birligi";
  return [
    { name: 'Javobsiz lead → menejerga vazifa', description: "2 soatdan ortiq javobsiz qolgan leadlar uchun mas'ul menejerga vazifa yaratiladi.", detector: 'lead_unanswered', params: { hours: 2 }, action_type: 'create_task', action_params: {} },
    { name: `${unit} to'lishi > 90% → leadlarni boshqa ${unit.toLowerCase()}ga`, description: "Sig'im 90% dan oshsa, yangi leadlar shu segmentdagi bo'sh birlikka yo'naltiriladi.", detector: 'group_capacity', params: { threshold: 0.9 }, action_type: 'route_leads', action_params: {} },
    { name: `${who} 7 kun faol emas → retention alert`, description: "7 kundan ortiq faol bo'lmagan mijozlar bo'yicha retention menejerga vazifa.", detector: 'customer_inactive', params: { days: 7 }, action_type: 'retention_outreach', action_params: {} },
    { name: 'CAC > maqsad → kampaniyani tahlil qilish', description: "Kampaniya CAC maqsaddan oshsa yoki keskin o'ssa, avtomatik tahlil tayyorlanadi.", detector: 'cac_above_target', params: { growthPct: 20 }, action_type: 'analyze_campaign', action_params: {} },
    { name: 'Churn xavfi → retention menejerni ogohlantirish', description: "Churn ehtimoli chegaradan yuqori mijozlar ro'yxati retention menejerga yuboriladi.", detector: 'churn_risk', params: { threshold: 0.6 }, action_type: 'notify_employee', action_params: { role: 'retention_manager' } },
    { name: "To'lov 3 kundan ortiq kechiksa → eslatma", description: "Muddati o'tgan to'lovlar bo'yicha mijozga eslatma (tasdiq bilan).", detector: 'payment_overdue', params: { days: 3 }, action_type: 'send_payment_reminder', action_params: {} },
  ];
}

export async function insertDefaultRules(db: Db, businessId: string, vertical: string) {
  await insertMany(
    db,
    'business_rules',
    ['id', 'business_id', 'name', 'description', 'detector', 'params', 'action_type', 'action_params', 'enabled'],
    defaultRules(vertical).map((r) => [newId('rul'), businessId, r.name, r.description, r.detector, r.params, r.action_type, r.action_params, true]),
  );
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface SetupInput {
  name: string;
  vertical?: Vertical;
  currency?: string;
  timezone?: string;
  strategy?: string | null;
  products?: Array<{ name: string; price: number; keywords?: string[] }>;
}

export async function setupBusiness(db: Db, input: SetupInput): Promise<Business> {
  const timezone = input.timezone ?? 'Asia/Tashkent';
  if (!isValidTimezone(timezone)) throw new UserError(`Noto'g'ri vaqt mintaqasi: ${timezone}`);
  const vertical = input.vertical ?? 'education';
  return db.tx(async (tx) => {
    const b = await createBusiness(tx, { name: input.name.trim(), vertical, currency: input.currency ?? 'UZS', timezone });
    if (input.strategy?.trim()) await updateBusiness(tx, b.id, { strategy: input.strategy.trim() });
    for (const p of input.products ?? []) {
      if (p.name.trim()) await upsertProduct(tx, b.id, { name: p.name, price: p.price, keywords: p.keywords });
    }
    await insertDefaultRules(tx, b.id, vertical);
    await tx.query(
      `INSERT INTO targets (id, business_id, kind, metric, label, target, comparator, priority)
       VALUES ($1,$2,'kpi','response_time_minutes','Leadga birinchi javob (SLA)',15,'lte',1)`,
      [newId('tgt'), b.id],
    );
    return getBusiness(tx, b.id);
  });
}
