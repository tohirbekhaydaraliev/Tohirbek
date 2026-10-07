import { existsSync } from 'node:fs';

// .env faylini (agar mavjud bo'lsa) yuklaymiz — Node 20.12+ da o'rnatilgan.
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

const port = Number(process.env.PORT ?? 8787);

export const config = {
  port,
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  apiToken: process.env.YOLDOSH_API_TOKEN || undefined,
  secretKey: process.env.YOLDOSH_SECRET_KEY || undefined,

  databaseUrl: process.env.DATABASE_URL || undefined,
  dataDir: process.env.YOLDOSH_DATA_DIR ?? './data/pg',
  seedDemo: bool(process.env.YOLDOSH_SEED_DEMO, true),

  model: process.env.YOLDOSH_MODEL || 'claude-opus-5-5',
  // SDK kalitni ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN yoki `ant auth login` profilidan oladi.
  // YOLDOSH_AI=on profil orqali ishlaganda AI'ni majburan yoqadi.
  aiEnabled:
    bool(process.env.YOLDOSH_AI, false) ||
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),

  timezone: process.env.YOLDOSH_TZ || 'Asia/Tashkent',
  schedulerEnabled: bool(process.env.YOLDOSH_SCHEDULER, true),
};

export type AppConfig = typeof config;
