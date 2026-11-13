import { useState } from 'react';
import { post } from '../lib/api';
import { Icon } from './Icon';

const VERTICALS = [
  { value: 'education', label: "Ta'lim (o'quv markazi, maktab)" },
  { value: 'retail', label: 'Savdo (do‘kon, onlayn savdo)' },
  { value: 'services', label: 'Xizmatlar (klinika, salon, agentlik)' },
  { value: 'other', label: 'Boshqa' },
];

interface ProductRow {
  name: string;
  price: string;
}

/** Haqiqiy biznesni yaratish: profil va mahsulotlar/kurslar. Ma'lumotlar keyin integratsiyalardan keladi. */
export function CreateBusinessForm({ onCreated, onCancel }: { onCreated: (b: { id: string; name: string }) => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [vertical, setVertical] = useState('education');
  const [strategy, setStrategy] = useState('');
  const [products, setProducts] = useState<ProductRow[]>([{ name: '', price: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<ProductRow>) => setProducts((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError('Biznes nomini kiriting');
    setBusy(true);
    try {
      const b = await post<{ id: string; name: string }>('/api/businesses', {
        name: name.trim(),
        vertical,
        strategy: strategy.trim() || undefined,
        products: products
          .filter((p) => p.name.trim())
          .map((p) => ({ name: p.name.trim(), price: Number(p.price.replace(/\s/g, '')) || 0 })),
      });
      onCreated(b);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="field">
        <label>Biznes nomi *</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Masalan: Edinburg o'quv markazi" autoFocus />
      </div>
      <div className="field">
        <label>Soha</label>
        <select className="select" value={vertical} onChange={(e) => setVertical(e.target.value)}>
          {VERTICALS.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Strategiya va maqsadlar (ixtiyoriy)</label>
        <textarea className="textarea" value={strategy} onChange={(e) => setStrategy(e.target.value)} placeholder="Masalan: yil oxirigacha 1500 faol mijoz, CAC 80 000 so'mdan oshmasin" />
        <span className="help">AI agentlar qaror chiqarishda shuni hisobga oladi.</span>
      </div>
      <div className="field">
        <label>Mahsulotlar / kurslar</label>
        <span className="help">Kampaniya, lead va to'lovlar shu nomlar bo'yicha segmentlarga ajratiladi (masalan "IELTS September" → IELTS).</span>
        {products.map((p, i) => (
          <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
            <input className="input" style={{ flex: 2 }} placeholder="Nomi (masalan IELTS)" value={p.name} onChange={(e) => setRow(i, { name: e.target.value })} />
            <input className="input tnum" style={{ flex: 1 }} placeholder="Oylik narx, so'm" inputMode="numeric" value={p.price} onChange={(e) => setRow(i, { price: e.target.value })} />
            <button type="button" className="btn ghost sm" onClick={() => setProducts((rows) => rows.filter((_, j) => j !== i))} aria-label="O'chirish" disabled={products.length === 1}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <div>
          <button type="button" className="btn ghost sm" onClick={() => setProducts((rows) => [...rows, { name: '', price: '' }])}>
            <Icon name="plus" size={14} /> Yana qo'shish
          </button>
        </div>
      </div>
      {error && <div className="notice error small">{error}</div>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Yaratilmoqda...' : 'Biznesni yaratish'}
        </button>
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Bekor qilish
          </button>
        )}
      </div>
      <div className="tiny muted">Standart biznes qoidalari va 15 daqiqalik javob SLA'si avtomatik qo'shiladi — keyin "Biznes konteksti"da o'zgartirasiz.</div>
    </form>
  );
}
