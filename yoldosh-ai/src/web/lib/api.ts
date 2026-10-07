/** API klienti: token (ixtiyoriy), xatolar, SSE oqimi. */

const TOKEN_KEY = 'yoldosh.token';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return safeGet(TOKEN_KEY);
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* brauzer xotirasi yopiq bo'lishi mumkin */
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  const token = getToken();
  if (token) h.set('Authorization', `Bearer ${token}`);
  return h;
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const h = headers(rest.headers);
  if (json !== undefined) h.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...rest, headers: h, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText);
  return data as T;
}

export const post = <T = any>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const patch = <T = any>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

/** Server-Sent Events (POST) — CEO agent javobini real vaqtda o'qish. */
export async function streamPost(path: string, json: unknown, onEvent: (event: string, data: any) => void): Promise<void> {
  const h = headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  const res = await fetch(path, { method: 'POST', headers: h, body: JSON.stringify(json) });
  if (!res.ok || !res.body) {
    const text = await res.text();
    let msg = res.statusText;
    try {
      msg = JSON.parse(text).error ?? msg;
    } catch {
      /* matn */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) {
        try {
          onEvent(event, JSON.parse(dataLines.join('\n')));
        } catch {
          onEvent(event, dataLines.join('\n'));
        }
      }
    }
  }
}
