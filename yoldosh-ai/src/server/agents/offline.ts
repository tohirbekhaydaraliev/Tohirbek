import type { Db } from '../db';
import { loadBrainContext } from '../brain/context';
import { listFindings } from '../brain/detectors';
import { computeDiagnosis, engineNarrative } from '../brain/diagnosis';
import { kpiSnapshot } from '../brain/kpis';
import { scoreChurn } from '../brain/scoring';
import * as q from '../metrics/queries';
import { comparisonRanges, fmtMinutes, fmtMoney, fmtPct } from '../lib/util';

/**
 * AI (Claude) ulanmagan holat uchun zaxira javoblar — diagnostika engine va metrikalar asosida.
 * Ilova API kalitisiz ham to'liq ishlaydi; AI esa chuqur, erkin savol-javob qo'shadi.
 */
export async function offlineAnswer(db: Db, businessId: string, question: string): Promise<string> {
  const t = question.toLowerCase();
  const ctx = await loadBrainContext(db, businessId);
  const note = "\n\n_AI rejimi o'chiq: bu javob diagnostika engine'idan. Erkin savol-javob va multi-agent tahlil uchun `ANTHROPIC_API_KEY` ni sozlang._";

  if (/(lead|javob|menejer|sotuv bo)/.test(t)) {
    const un = await q.unansweredLeads(db, businessId, ctx.business.settings.unansweredHours, ctx.at);
    const { current, previous } = comparisonRanges(30, ctx.at);
    const [rc, rp] = await Promise.all([
      q.responseTimes(db, businessId, current, 'segment', ctx.business.settings.responseSlaMinutes),
      q.responseTimes(db, businessId, previous, 'segment', ctx.business.settings.responseSlaMinutes),
    ]);
    const byMgr = un.reduce<Record<string, number>>((m, l) => ((m[l.manager_name ?? '—'] = (m[l.manager_name ?? '—'] ?? 0) + 1), m), {});
    return (
      `**${un.length} ta lead ${ctx.business.settings.unansweredHours}+ soatdan beri javobsiz.** ${Object.entries(byMgr)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')}\n\n**Birinchi javob vaqti (median, 30 kun):**\n` +
      rc.map((r) => `- ${r.label}: ${fmtMinutes(rp.find((x) => x.key === r.key)?.medianMinutes ?? null)} → ${fmtMinutes(r.medianMinutes)} (SLA ichida ${Math.round(r.withinSlaShare * 100)}%)`).join('\n') +
      note
    );
  }
  if (/(churn|ketish|xavf|davomat|mijoz)/.test(t)) {
    const risky = (await scoreChurn(ctx)).filter((s) => s.probability >= ctx.business.settings.churnThreshold).sort((a, b) => b.probability - a.probability);
    return (
      `**${risky.length} ta mijoz churn xavfida** (chegara ${Math.round(ctx.business.settings.churnThreshold * 100)}%):\n` +
      risky
        .slice(0, 10)
        .map((s) => `- ${s.name} (${s.segment ?? '—'}) — ${Math.round(s.probability * 100)}%: ${s.reasons.slice(0, 2).join('; ')}`)
        .join('\n') +
      note
    );
  }
  if (/(kampaniya|reklama|cac|cpl|marketing|byudjet)/.test(t)) {
    const { current, previous } = comparisonRanges(30, ctx.at);
    const [cur, prev] = await Promise.all([q.campaignPerformance(db, businessId, current), q.campaignPerformance(db, businessId, previous)]);
    return (
      `**Kampaniyalar (30 kun):**\n` +
      cur
        .filter((c) => c.spend > 0)
        .map((c) => {
          const p = prev.find((x) => x.campaign_id === c.campaign_id);
          return `- ${c.name}: xarajat ${fmtMoney(c.spend)}, ${c.platform_leads || c.crm_leads} lead, ${c.won} sotuv, CAC ${c.cac ? fmtMoney(c.cac) : '—'}${p?.cac && c.cac ? ` (${fmtPct((c.cac - p.cac) / p.cac)})` : ''}`;
        })
        .join('\n') +
      note
    );
  }
  if (/(to'lov|tolov|qarz|kechik|moliya|pul)/.test(t)) {
    const rows = await q.overduePayments(db, businessId, ctx.at, 3);
    return `**${rows.length} ta to'lov 3+ kun kechikkan**, jami ${fmtMoney(rows.reduce((a, r) => a + r.amount, 0))}.\n${rows
      .slice(0, 10)
      .map((r) => `- ${r.customer_name}: ${fmtMoney(r.amount)}, ${r.days_overdue} kun`)
      .join('\n')}${note}`;
  }
  if (/(nega|nima uchun|sabab|daromad|revenue|tush|diagnoz|nima bo|holat|qanday)/.test(t)) {
    const findings = await listFindings({ db, businessId }, 'open');
    const d = await computeDiagnosis(ctx, findings);
    return engineNarrative(d) + note;
  }
  const snap = await kpiSnapshot(ctx);
  return (
    `**Asosiy ko'rsatkichlar (so'nggi ${snap.windowDays} kun):**\n` +
    snap.kpis
      .filter((k) => k.current !== null)
      .map((k) => `- ${k.label}: ${k.unit === 'money' ? fmtMoney(k.current!) : k.unit === 'ratio' ? `${Math.round(k.current! * 1000) / 10}%` : k.unit === 'minutes' ? fmtMinutes(k.current) : Math.round(k.current!)} (${fmtPct(k.change)})`)
      .join('\n') +
    `\n\nSavol misollari: "Nega daromad tushdi?", "Javobsiz leadlar", "Churn xavfidagi mijozlar", "Kampaniyalar CAC".` +
    note
  );
}
