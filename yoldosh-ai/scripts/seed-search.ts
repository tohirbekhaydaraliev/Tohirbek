import { createPGlite } from '../src/server/db/client';
import { migrate } from '../src/server/db';
import { seedDemo } from '../src/server/demo/seed';
import * as q from '../src/server/metrics/queries';
import { comparisonRanges, now } from '../src/server/lib/util';
const seeds = process.argv.slice(2).map(Number);
for (const seed of seeds) {
  const db = await createPGlite(); await migrate(db); const b = await seedDemo(db, { seed });
  const { current, previous } = comparisonRanges(30);
  const rc = await q.revenueSummary(db, b, current), rp = await q.revenueSummary(db, b, previous);
  const cc = await q.campaignPerformance(db, b, current), cp = await q.campaignPerformance(db, b, previous);
  const c17 = cc.find((c) => c.name.startsWith('#17'))!, p17 = cp.find((c) => c.name.startsWith('#17'))!;
  const rt = await q.responseTimes(db, b, current, 'segment', 15);
  const fc = q.totalFunnel(await q.funnelBySegment(db, b, current)), fp = q.totalFunnel(await q.funnelBySegment(db, b, previous));
  const mc = await q.marketingTotals(db, b, current), mp = await q.marketingTotals(db, b, previous);
  const un = (await q.unansweredLeads(db, b, 2, now())).length;
  console.log(seed, 'rev', ((rc.total / rp.total - 1) * 100).toFixed(1), 'newShare', ((rc.newRevenue - rp.newRevenue) / (rc.total - rp.total)).toFixed(2),
    'c17cac', ((c17.cac! / p17.cac! - 1) * 100).toFixed(0), 'ieltsRT', rt.find((r) => r.key === 'IELTS')?.medianMinutes?.toFixed(0),
    'conv', (fp.conversion * 100).toFixed(1), '->', (fc.conversion * 100).toFixed(1), 'cac', Math.round(mp.cac!), '->', Math.round(mc.cac!), 'unans', un);
  await db.close();
}
