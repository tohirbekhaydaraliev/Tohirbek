import { createPGlite } from '../src/server/db/client';
import { migrate } from '../src/server/db';
import { seedDemo } from '../src/server/demo/seed';
import * as q from '../src/server/metrics/queries';
import { comparisonRanges, now } from '../src/server/lib/util';

const t0 = Date.now();
const db = await createPGlite();
await migrate(db);
const b = await seedDemo(db);
console.log('seed ms', Date.now() - t0);
const { current, previous } = comparisonRanges(30);
for (const [name, r] of [['cur', current], ['prev', previous]] as const) {
  const rev = await q.revenueSummary(db, b, r);
  const f = await q.funnelBySegment(db, b, r);
  const rt = await q.responseTimes(db, b, r, 'segment', 15);
  const mk = await q.marketingTotals(db, b, r);
  console.log(name, JSON.stringify({ total: rev.total, newR: rev.newRevenue, ren: rev.renewal, newN: rev.newPayments, renN: rev.renewalPayments }));
  console.log(' funnel', f.map((x) => `${x.segment}: leads ${x.leads} won ${x.won} conv ${(x.conversion * 100).toFixed(1)}%`).join(' | '), 'total', (q.totalFunnel(f).conversion * 100).toFixed(1));
  console.log(' rt', rt.map((x) => `${x.key}: med ${x.medianMinutes?.toFixed(1)} sla ${(x.withinSlaShare * 100).toFixed(0)}%`).join(' | '));
  console.log(' mk', mk);
  console.log(' active', await q.activeCustomers(db, b, r.end), 'att', await q.attendanceRate(db, b, r));
}
const un = await q.unansweredLeads(db, b, 2, now());
console.log('unanswered', un.length, un.reduce((m: any, x) => ((m[x.manager_name ?? '-'] = (m[x.manager_name ?? '-'] ?? 0) + 1), m), {}));
const camp = await q.campaignPerformance(db, b, current);
const campPrev = await q.campaignPerformance(db, b, previous);
for (const c of camp) {
  const p = campPrev.find((x) => x.campaign_id === c.campaign_id);
  console.log(' camp', c.name, 'spend', c.spend, 'won', c.won, 'cac', Math.round(c.cac ?? -1), 'prev cac', Math.round(p?.cac ?? -1), 'cpl', Math.round(c.cpl));
}
console.log('overdue', (await q.overduePayments(db, b, now(), 3)).length);
console.log('capacity', (await q.groupCapacity(db, b)).slice(0, 4).map((g) => `${g.name} ${g.active}/${g.capacity}`));
console.log('bucket IELTS', await q.conversionByResponseBucket(db, b, now(), { segment: 'IELTS' }));
console.log('churn', await q.churnStats(db, b, current), 'tenure', await q.avgTenureMonths(db, b, now()));
