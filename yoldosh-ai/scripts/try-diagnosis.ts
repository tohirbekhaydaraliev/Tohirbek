import { createPGlite } from '../src/server/db/client';
import { migrate } from '../src/server/db';
import { seedDemo } from '../src/server/demo/seed';
import { runDiagnosis } from '../src/server/brain/service';
import { runRules } from '../src/server/context/rules';
import { listActions } from '../src/server/actions/service';
import type { TreeNode } from '../src/shared/types';

const db = await createPGlite(); await migrate(db); const b = await seedDemo(db);
const t0 = Date.now();
const d = await runDiagnosis(db, b, { kind: 'daily', narrate: false });
console.log('diagnosis ms', Date.now() - t0);
const print = (n: TreeNode, depth = 0) => {
  if (depth > 6) return;
  console.log(`${'  '.repeat(depth)}${n.onPath ? '★' : '·'} ${n.label} [${n.relation}/${n.status}] ${Math.round(n.previous * 100) / 100} → ${Math.round(n.current * 100) / 100} ch=${n.change === null ? '-' : Math.round(n.change * 1000) / 10 + '%'} share=${n.share === null ? '-' : Math.round(n.share * 100) + '%'}`);
  n.children.forEach((c) => print(c, depth + 1));
};
print(d.tree);
console.log('\nROOT CAUSE', JSON.stringify(d.rootCause, null, 2));
console.log('\nPRIORITIES', d.priorities.map((p) => `${p.rank}. [${p.severity}] ${p.title}`).join('\n'));
console.log('\nRECS', d.recommendations.map((r) => `${r.title} | ${r.actionType} | ${r.risk} | conf ${r.confidence} | ${r.actionStatus}`).join('\n'));
console.log('\nNARRATIVE\n' + d.narrative);
const rr = await runRules(db, b);
console.log('\nRULES', rr.map((r) => `${r.name}: findings ${r.findings}, proposed ${r.proposed}, executed ${r.executed}, pending ${r.pending} ${r.errors.join(';')}`).join('\n'));
const rr2 = await runRules(db, b);
console.log('RULES 2nd run proposed', rr2.reduce((a, r) => a + r.proposed, 0));
const acts = await listActions(db, b, { limit: 40 });
console.log('\nACTIONS', acts.map((a) => `${a.status} ${a.risk} ${a.type}: ${a.title} => ${(a.result as any)?.summary ?? a.error ?? ''}`).join('\n'));
