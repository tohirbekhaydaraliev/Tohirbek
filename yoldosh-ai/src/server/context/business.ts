import type { Db } from '../db';
import { DEFAULT_SETTINGS, type Business, type BusinessSettings } from '../../shared/types';
import { newId } from '../lib/util';

interface BusinessRow {
  id: string;
  name: string;
  vertical: string;
  currency: string;
  timezone: string;
  strategy: string | null;
  priorities: string[];
  settings: Partial<BusinessSettings>;
}

export function mergeSettings(partial: Partial<BusinessSettings> | null | undefined): BusinessSettings {
  const p = partial ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...p,
    autonomy: { ...DEFAULT_SETTINGS.autonomy, ...(p.autonomy ?? {}), high: 'approval' },
    leadRouting: { ...DEFAULT_SETTINGS.leadRouting, ...(p.leadRouting ?? {}) },
  };
}

function toBusiness(row: BusinessRow): Business {
  return {
    id: row.id,
    name: row.name,
    vertical: row.vertical,
    currency: row.currency,
    timezone: row.timezone,
    strategy: row.strategy,
    priorities: Array.isArray(row.priorities) ? row.priorities : [],
    settings: mergeSettings(row.settings),
  };
}

export async function getBusiness(db: Db, businessId: string): Promise<Business> {
  const row = await db.one<BusinessRow>('SELECT * FROM businesses WHERE id = $1', [businessId]);
  if (!row) throw new Error(`Biznes topilmadi: ${businessId}`);
  return toBusiness(row);
}

export async function listBusinesses(db: Db): Promise<Business[]> {
  const rows = await db.query<BusinessRow>('SELECT * FROM businesses ORDER BY created_at');
  return rows.map(toBusiness);
}

export async function createBusiness(
  db: Db,
  input: { name: string; vertical?: string; currency?: string; timezone?: string; id?: string },
): Promise<Business> {
  const id = input.id ?? newId('biz');
  await db.query(
    `INSERT INTO businesses (id, name, vertical, currency, timezone, settings) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.name, input.vertical ?? 'education', input.currency ?? 'UZS', input.timezone ?? 'Asia/Tashkent', DEFAULT_SETTINGS],
  );
  return getBusiness(db, id);
}

export async function updateBusiness(
  db: Db,
  businessId: string,
  patch: { name?: string; strategy?: string | null; priorities?: string[]; settings?: Partial<BusinessSettings> },
): Promise<Business> {
  const current = await getBusiness(db, businessId);
  const settings = patch.settings ? mergeSettings({ ...current.settings, ...patch.settings }) : current.settings;
  await db.query(
    `UPDATE businesses SET name = $2, strategy = $3, priorities = $4, settings = $5 WHERE id = $1`,
    [
      businessId,
      patch.name ?? current.name,
      patch.strategy !== undefined ? patch.strategy : current.strategy,
      JSON.stringify(patch.priorities ?? current.priorities),
      settings,
    ],
  );
  return getBusiness(db, businessId);
}
