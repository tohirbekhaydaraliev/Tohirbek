import { config } from '../config';
import { createPGlite, createPostgres, type Db } from './client';
import { migration001 } from './migrations/001_init';

export type { Db } from './client';
export { insertMany, json } from './client';

const MIGRATIONS: Array<{ id: string; sql: string }> = [{ id: '001_init', sql: migration001 }];

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.tx(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
    ran.push(m.id);
  }
  return ran;
}

/** Konfiguratsiyaga ko'ra bazani ochadi va migratsiyalarni bajaradi. */
export async function openDatabase(opts: { inMemory?: boolean } = {}): Promise<Db> {
  const db = config.databaseUrl && !opts.inMemory
    ? await createPostgres(config.databaseUrl)
    : await createPGlite(opts.inMemory ? undefined : config.dataDir);
  await migrate(db);
  return db;
}
