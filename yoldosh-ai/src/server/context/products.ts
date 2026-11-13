import type { Db } from '../db';
import { UserError } from '../lib/errors';
import { newId } from '../lib/util';

/**
 * Mahsulotlar / kurslar — segmentlarni aniqlash uchun asos:
 * "IELTS September" kampaniyasi yoki "IELTS kursi" to'lovi → IELTS segmenti.
 */
export interface Product {
  id: string;
  name: string;
  segment: string;
  price: number;
  keywords: string[];
  active: boolean;
}

export async function listProducts(db: Db, businessId: string): Promise<Product[]> {
  return db.query<Product>(
    `SELECT id, name, segment, price, keywords, active FROM products WHERE business_id = $1 AND active ORDER BY name`,
    [businessId],
  );
}

export async function upsertProduct(
  db: Db,
  businessId: string,
  input: { id?: string; name: string; segment?: string; price: number; keywords?: string[] },
): Promise<Product> {
  const name = input.name.trim();
  if (!name) throw new UserError('Mahsulot nomi bo‘sh bo‘lmasligi kerak');
  const keywords = (input.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  const values = [name, input.segment?.trim() || name, Math.max(0, Math.round(input.price)), keywords];
  let id = input.id;
  if (id) {
    // Faqat shu biznesga tegishli mahsulot yangilanadi
    const updated = await db.query(
      `UPDATE products SET name = $3, segment = $4, price = $5, keywords = $6 WHERE id = $1 AND business_id = $2 RETURNING id`,
      [id, businessId, ...values],
    );
    if (!updated.length) throw new UserError('Mahsulot topilmadi', 404);
  } else {
    id = newId('prd');
    await db.query(`INSERT INTO products (id, business_id, name, segment, price, keywords) VALUES ($1,$2,$3,$4,$5,$6)`, [id, businessId, ...values]);
  }
  const row = await db.one<Product>('SELECT id, name, segment, price, keywords, active FROM products WHERE id = $1 AND business_id = $2', [id, businessId]);
  if (!row) throw new UserError('Mahsulot topilmadi', 404);
  return row;
}

/** O'chirish — yumshoq (tarixiy sotuvlar va obunalar bog'liqligi saqlanadi). */
export async function deactivateProduct(db: Db, businessId: string, id: string): Promise<void> {
  await db.query('UPDATE products SET active = false WHERE business_id = $1 AND id = $2', [businessId, id]);
}
