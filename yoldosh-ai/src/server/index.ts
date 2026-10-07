import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config';
import { listBusinesses } from './context/business';
import { openDatabase } from './db';
import { runDiagnosis } from './brain/service';
import { runRules } from './context/rules';
import { seedDemo } from './demo/seed';
import { createApp } from './http/app';
import { startScheduler } from './scheduler';

const WEB_DIR = './dist/web';

async function main() {
  const db = await openDatabase();
  console.log(`[yoldosh] Ma'lumotlar bazasi: ${db.kind === 'pglite' ? `PGlite (${config.dataDir})` : 'PostgreSQL'}`);

  if ((await listBusinesses(db)).length === 0 && config.seedDemo) {
    console.log("[yoldosh] Demo biznes yaratilmoqda (\"Edinburg\" o'quv markazi)...");
    const businessId = await seedDemo(db);
    await runDiagnosis(db, businessId, { kind: 'daily', narrate: false });
    await runRules(db, businessId);
    console.log('[yoldosh] Demo tayyor.');
  }

  const app = createApp(db);

  // Production: tayyor web ilovani shu serverning o'zidan beramiz
  if (existsSync(WEB_DIR)) {
    app.use('/assets/*', serveStatic({ root: WEB_DIR }));
    app.use('/favicon.svg', serveStatic({ root: WEB_DIR }));
    // index.html har so'rovda o'qiladi (kichik fayl) — qayta build'dan keyin ham eski asset'larga ishora qilmaydi
    app.get('*', (c) =>
      c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')
        ? c.json({ error: 'Topilmadi' }, 404)
        : c.html(readFileSync(`${WEB_DIR}/index.html`, 'utf8')),
    );
  }

  const stopScheduler = config.schedulerEnabled ? startScheduler(db) : () => {};
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[yoldosh] Yo'ldosh AI ishga tushdi: http://localhost:${info.port}`);
    console.log(`[yoldosh] AI (Claude): ${config.aiEnabled ? `yoqilgan — ${config.model}` : "o'chiq (ANTHROPIC_API_KEY o'rnatilmagan) — diagnostika engine rejimi"}`);
  });

  const shutdown = async () => {
    stopScheduler();
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
