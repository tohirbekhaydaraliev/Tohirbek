import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import type { ConfigField } from '../../shared/types';

/**
 * Connector maxfiy maydonlari (tokenlar) bazada AES-256-GCM bilan shifrlanadi
 * (YOLDOSH_SECRET_KEY o'rnatilgan bo'lsa). API javoblarida hech qachon qaytarilmaydi.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer | null {
  if (!config.secretKey) return null;
  return createHash('sha256').update(config.secretKey).digest();
}

export function encryptValue(value: string): string {
  const k = key();
  if (!k || !value || value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decryptValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const k = key();
  if (!k) throw new Error("Shifrlangan maxfiy qiymat bor, lekin YOLDOSH_SECRET_KEY o'rnatilmagan");
  const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptConfig(fields: ConfigField[], cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const f of fields) {
    if (f.type === 'secret' && typeof out[f.key] === 'string' && out[f.key]) out[f.key] = encryptValue(out[f.key] as string);
  }
  return out;
}

export function decryptConfig(cfg: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg ?? {})) out[k] = decryptValue(v);
  return out;
}

export function maskConfig(fields: ConfigField[], cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg ?? {})) {
    const f = fields.find((x) => x.key === k);
    out[k] = f?.type === 'secret' ? (v ? '••••••••' : '') : v;
  }
  return out;
}
