import type { AutonomyMode, BusinessSettings, RiskLevel } from '../../shared/types';

/**
 * Human-in-the-loop siyosati.
 * - Low: AI o'zi bajaradi (sozlamada "tasdiq bilan" qilish mumkin)
 * - Medium: AI tavsiya qiladi, inson tasdiqlaydi (avtonomiya oshgach "auto" qilish mumkin)
 * - High: har doim faqat inson tasdig'i bilan — sozlama bilan o'zgartirib bo'lmaydi
 */
export function decidePolicy(risk: RiskLevel, settings: BusinessSettings, source: string): AutonomyMode {
  if (risk === 'high') return 'approval';
  if (source === 'agent' && risk === 'low' && !settings.agentLowRiskAuto) return 'approval';
  if (source === 'user') return 'auto'; // foydalanuvchining o'zi yaratgan harakat — tasdiq uning o'zi
  return settings.autonomy[risk] === 'auto' ? 'auto' : 'approval';
}
