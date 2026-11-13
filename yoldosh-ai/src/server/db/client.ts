import { mkdirSync } from 'node:fs';
import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * Data Layer uchun yupqa abstraksiya.
 * - DATABASE_URL berilsa — haqiqiy PostgreSQL (node-postgres).
 * - Aks holda — PGlite (WASM'da ishlaydigan to'liq PostgreSQL), hech qanday o'rnatishsiz.
 * Ikkalasi ham bir xil SQL dialektini ishlatadi.
 */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pglite' | 'postgres';
}

// int8/numeric -> number, date -> 'YYYY-MM-DD' satr (vaqt mintaqasi chalkashligisiz)
const toNumber = (v: string) => Number(v);
const identity = (v: string) => v;

function normalizeParams(params: unknown[] | undefined): unknown[] | undefined {
  if (!params) return params;
  return params.map((p) => {
    if (p === undefined) return null;
    if (p !== null && typeof p === 'object' && !Array.isArray(p) && !(p instanceof Date) && !Buffer.isBuffer(p)) {
      // jsonb ustunlar uchun oddiy obyektlarni JSON satrga aylantiramiz.
      // Massivlar Postgres massivi sifatida uzatiladi (`= ANY($1)`); jsonb massiv uchun json() ishlating.
      return JSON.stringify(p);
    }
    return p;
  });
}

type PGliteLike = Pick<PGlite, 'query' | 'exec'>;

function wrapPGlite(conn: PGliteLike, root: PGlite | null): Db {
  const db: Db = {
    kind: 'pglite',
    async query<T>(sql: string, params?: unknown[]) {
      const res = await conn.query<T>(sql, normalizeParams(params));
      return res.rows;
    },
    async one<T>(sql: string, params?: unknown[]) {
      const res = await conn.query<T>(sql, normalizeParams(params));
      return res.rows[0];
    },
    async exec(sql: string) {
      await conn.exec(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (!root) return fn(db); // ichma-ich tranzaksiya — mavjudini ishlatamiz
      return root.transaction(async (t) => fn(wrapPGlite(t as unknown as PGliteLike, null)));
    },
    async close() {
      if (root) await root.close();
    },
  };
  return db;
}

export async function createPGlite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const parsers = {
    [pgliteTypes.INT8]: toNumber,
    [pgliteTypes.NUMERIC]: toNumber,
    [pgliteTypes.DATE]: identity,
  };
  const instance = dataDir ? new PGlite(dataDir, { parsers }) : new PGlite({ parsers });
  await instance.waitReady;
  return wrapPGlite(instance, instance);
}

let pgParsersInstalled = false;
function installPgParsers() {
  if (pgParsersInstalled) return;
  pg.types.setTypeParser(20, toNumber); // int8
  pg.types.setTypeParser(1700, toNumber); // numeric
  pg.types.setTypeParser(1082, identity); // date
  pgParsersInstalled = true;
}

function wrapPgClient(client: pg.PoolClient): Db {
  const db: Db = {
    kind: 'postgres',
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, normalizeParams(params) as any[]);
      return res.rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, normalizeParams(params) as any[]);
      return res.rows[0] as T | undefined;
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      return fn(db);
    },
    async close() {
      /* pool-level */
    },
  };
  return db;
}

export async function createPostgres(url: string): Promise<Db> {
  installPgParsers();
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query('select 1');
  return {
    kind: 'postgres',
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, normalizeParams(params) as any[]);
      return res.rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, normalizeParams(params) as any[]);
      return res.rows[0] as T | undefined;
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrapPgClient(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** jsonb ustunga massiv (yoki istalgan qiymat) yozish uchun. */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * Ko'p qatorni bitta so'rovda kiritish (seed va ingest uchun tez).
 * `rows` — ustunlar tartibidagi qiymatlar massivi.
 */
export async function insertMany(
  db: Db,
  table: string,
  columns: string[],
  rows: unknown[][],
  options: { onConflict?: string; chunkSize?: number } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = options.chunkSize ?? Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}${
      options.onConflict ? ` ${options.onConflict}` : ''
    }`;
    await db.query(sql, params);
  }
}
