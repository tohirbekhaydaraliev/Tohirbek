import { openDatabase } from './db';
import { listBusinesses } from './context/business';
import { runRules } from './context/rules';
import { runDiagnosis } from './brain/service';
import { DEMO_BUSINESS_ID, resetDemo, seedDemo } from './demo/seed';

/**
 * Buyruqlar qatori:
 *   npm run seed       — demo biznesni qayta yaratish
 *   npm run diagnose   — kunlik diagnostikani hozir ishga tushirish va natijani chiqarish
 */
async function main() {
  const cmd = process.argv[2];
  const db = await openDatabase();
  if (cmd === 'seed') {
    await resetDemo(db, DEMO_BUSINESS_ID);
    const id = await seedDemo(db);
    await runDiagnosis(db, id, { kind: 'daily', narrate: false });
    await runRules(db, id);
    console.log(`Demo biznes tayyor: ${id}`);
  } else if (cmd === 'diagnose') {
    for (const b of await listBusinesses(db)) {
      const d = await runDiagnosis(db, b.id, { kind: 'adhoc' });
      console.log(`\n=== ${b.name} ===\n${d.narrative}\n`);
    }
  } else {
    console.log('Foydalanish: tsx src/server/cli.ts <seed|diagnose>');
  }
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
