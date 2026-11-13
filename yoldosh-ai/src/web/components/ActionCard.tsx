import { useState } from 'react';
import type { ActionView } from '../../shared/types';
import { post } from '../lib/api';
import { ago, date, pct, SOURCE_LABEL, STATUS_LABEL, value, VERDICT_LABEL } from '../lib/format';
import { useApp } from '../lib/hooks';
import { Icon } from './Icon';
import { RiskBadge } from './ui';

const VERDICT_CLASS: Record<string, string> = { improved: 'sev-good', worsened: 'sev-critical', no_change: '', unknown: '', pending: '' };
const VERDICT_ICON: Record<string, string> = { improved: 'up', worsened: 'down', no_change: 'check', unknown: 'eye', pending: 'clock' };

export function ActionCard({ action, onChange, compact }: { action: ActionView; onChange?: (a: ActionView) => void; compact?: boolean }) {
  const { toast, refreshCounts } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const pending = action.status === 'proposed';

  const decide = async (op: 'approve' | 'reject' | 'ignore') => {
    setBusy(op);
    try {
      const updated = await post<ActionView>(`/api/actions/${action.id}/${op}`);
      onChange?.(updated);
      refreshCounts();
      toast(
        op === 'approve'
          ? updated.status === 'executed'
            ? `Bajarildi: ${(updated.result as any)?.summary ?? updated.title}`
            : `Xato: ${updated.error}`
          : op === 'reject'
            ? 'Harakat rad etildi'
            : "Harakat e'tiborsiz qoldirildi",
      );
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const result = action.result as { summary?: string; simulated?: boolean; manual?: boolean } | null;
  const o = action.outcome;

  return (
    <div className={`action-card ${pending ? 'pending' : ''}`}>
      <div className="action-head">
        <div className="stack" style={{ gap: 6 }}>
          <div className="action-title">{action.title}</div>
          <div className="action-meta">
            <RiskBadge risk={action.risk} />
            <span className="badge">{action.typeLabel}</span>
            <span className="badge accent">{SOURCE_LABEL[action.source] ?? action.source}</span>
            {!pending && <span className="badge">{STATUS_LABEL[action.status] ?? action.status}</span>}
            {result?.simulated && (
              <span className="badge" title="Tegishli integratsiya ulanmagan — harakat ichki tizimda bajarildi">
                Ichki tizimda
              </span>
            )}
            {action.confidence !== null && pending && <span className="tiny muted">Ishonch: {pct(action.confidence, 0)}</span>}
          </div>
        </div>
        <span className="tiny muted nowrap">{ago(action.createdAt)}</span>
      </div>

      {expanded && action.rationale && <div className="action-body">{action.rationale}</div>}
      {expanded && action.expectedImpact && (
        <div className="small ink2">
          <span className="muted">Kutilgan natija: </span>
          {action.expectedImpact}
        </div>
      )}
      {result?.summary && (
        <div className="action-result">
          {result.manual && <strong>Qo'lda bajariladi · </strong>}
          {result.summary}
        </div>
      )}
      {action.error && <div className="notice error small">{action.error}</div>}
      {o && (
        <div className="outcome-line">
          <span className={`badge ${VERDICT_CLASS[o.verdict]}`}>
            <Icon name={VERDICT_ICON[o.verdict]} size={12} stroke={2.2} />
            {VERDICT_LABEL[o.verdict]}
          </span>
          <span>
            {o.label}: {value(o.baseline, o.unit)}
            {o.observed !== null ? ` → ${value(o.observed, o.unit)}` : ''}
          </span>
          {o.verdict === 'pending' && <span className="muted">· baholash: {date(o.evaluateAt, true)}</span>}
        </div>
      )}

      {(pending || compact) && (
        <div className="row" style={{ gap: 8 }}>
          {pending && (
            <>
              <button className="btn primary sm" disabled={!!busy} onClick={() => decide('approve')}>
                <Icon name="check" size={15} /> {busy === 'approve' ? 'Bajarilmoqda...' : 'Tasdiqlash'}
              </button>
              <button className="btn sm" disabled={!!busy} onClick={() => decide('reject')}>
                Rad etish
              </button>
              <button className="btn ghost sm" disabled={!!busy} onClick={() => decide('ignore')}>
                E'tiborsiz qoldirish
              </button>
            </>
          )}
          {compact && (action.rationale || action.expectedImpact) && (
            <button className="btn ghost sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Yashirish' : 'Batafsil'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
