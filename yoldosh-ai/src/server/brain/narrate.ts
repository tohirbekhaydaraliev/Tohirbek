import { complete } from '../agents/llm';
import type { DiagnosisDraft } from './diagnosis';
import { describeChange } from './diagnosis';

const SYSTEM = `Siz — Yo'ldosh AI, biznes rahbari uchun AI operatsion yordamchisiz.
Sizga diagnostika engine hisoblagan tuzilgan natija (KPI'lar, root cause yo'li, dalillar, ustuvorliklar, tavsiyalar) beriladi.
Vazifa: rahbar 30 soniyada o'qiydigan qisqa kunlik diagnostika yozing.

Qoidalar:
- O'zbek tilida (lotin), aniq va ishbilarmon uslubda yozing. Biznes atamalari (CAC, CPL, lead, konversiya) o'zgarishsiz qolishi mumkin.
- Faqat berilgan raqamlardan foydalaning; yangi raqam to'qimang.
- Tuzilma: 1) bir jumlali umumiy holat, 2) "Asosiy sabab" — sababiy zanjir (nima → nimaga ta'sir qildi), 3) dalillar (2–3 band), 4) "Bugun nima qilish kerak" — tavsiyalar ro'yxati.
- 180 so'zdan oshmasin. Markdown: qisqa sarlavhalar va ro'yxatlar.`;

export async function narrateDiagnosis(d: DiagnosisDraft, businessName: string): Promise<string> {
  const pathNodes = (d.rootCause?.path ?? []).map((key) => {
    const find = (n: typeof d.tree): typeof d.tree | null => (n.key === key ? n : n.children.map(find).find(Boolean) ?? null);
    const node = find(d.tree);
    return node ? `${node.label}: ${describeChange(node)}${node.share ? ` (ota o'zgarishining ${Math.round(node.share * 100)}%)` : ''}` : key;
  });
  const payload = {
    biznes: businessName,
    davr_kun: d.windowDays,
    kpi: d.kpis.map((k) => ({ nomi: k.label, joriy: k.current, oldingi: k.previous, ozgarish: k.change, maqsad: k.target ?? null })),
    root_cause: d.rootCause,
    root_cause_yoli: pathNodes,
    ustuvorliklar: d.priorities.map((p) => ({ nomi: p.title, tafsilot: p.detail })),
    tavsiyalar: d.recommendations.map((r) => ({ nomi: r.title, xavf: r.risk, kutilgan_natija: r.expectedImpact })),
  };
  return complete({ system: SYSTEM, user: `Diagnostika natijasi (JSON):\n${JSON.stringify(payload)}`, effort: 'low' });
}
