import { Cron } from 'croner';
import type { Db } from './db';
import { listBusinesses } from './context/business';
import { runRules } from './context/rules';
import { loadBrainContext } from './brain/context';
import { refreshFindings } from './brain/detectors';
import { hasDailyDiagnosisToday, runDiagnosis } from './brain/service';
import { sendDailyDigest } from './bot/telegram';
import { syncAll } from './connectors/registry';
import { evaluateDueOutcomes } from './feedback/outcomes';
import { errorMessage } from './lib/util';

/**
 * Rejalashtiruvchi — tizimning "yurak urishi":
 *  - har 15 daqiqada: connectorlardan ma'lumot olish (API pull)
 *  - har 10 daqiqada: detektorlar + biznes qoidalari (Detect → Act)
 *  - har soatda: harakatlar natijasini baholash (Feedback Loop) va kunlik diagnostika vaqtini tekshirish
 */

function localHour(timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date()));
}

async function safe(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    console.error(`[scheduler] ${name}:`, errorMessage(err));
  }
}

export async function dailyDiagnosisTick(db: Db, opts: { force?: boolean } = {}) {
  for (const b of await listBusinesses(db)) {
    const due = opts.force || localHour(b.timezone) >= b.settings.dailyDigestHour;
    if (!due || (await hasDailyDiagnosisToday(db, b.id))) continue;
    await safe(`daily diagnosis ${b.id}`, async () => {
      const d = await runDiagnosis(db, b.id, { kind: 'daily' });
      console.log(`[scheduler] ${b.name}: kunlik diagnostika tayyor — ${d.rootCause?.headline ?? 'jiddiy muammo yo‘q'}`);
      await sendDailyDigest(db, b.id, d);
    });
  }
}

export async function rulesTick(db: Db) {
  for (const b of await listBusinesses(db)) {
    await safe(`rules ${b.id}`, async () => {
      await refreshFindings(await loadBrainContext(db, b.id));
      const res = await runRules(db, b.id);
      const created = res.reduce((a, r) => a + r.proposed, 0);
      if (created) console.log(`[scheduler] ${b.name}: qoidalar ${created} ta harakat yaratdi`);
    });
  }
}

export function startScheduler(db: Db): () => void {
  const jobs = [
    new Cron('*/15 * * * *', { protect: true }, () => safe('sync', () => syncAll(db))),
    new Cron('*/10 * * * *', { protect: true }, () => safe('rules', () => rulesTick(db))),
    new Cron('5 * * * *', { protect: true }, async () => {
      await safe('outcomes', () => evaluateDueOutcomes(db));
      await dailyDiagnosisTick(db);
    }),
  ];
  // Ishga tushganda: bugungi diagnostika yo'q bo'lsa — tayyorlaymiz, qoidalarni bir marta yuritamiz
  setTimeout(() => {
    void (async () => {
      await safe('startup outcomes', () => evaluateDueOutcomes(db));
      await rulesTick(db);
      await dailyDiagnosisTick(db, { force: true });
    })();
  }, 1500);
  return () => jobs.forEach((j) => j.stop());
}
