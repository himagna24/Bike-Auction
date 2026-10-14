export const API_URL: string = (import.meta as any).env?.VITE_API_URL ?? '';

let token: string | null = null;
try { token = localStorage.getItem('token'); } catch { /* storage unavailable */ }
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  try { t ? localStorage.setItem('token', t) : localStorage.removeItem('token'); } catch { /* ignore */ }
}

export class ApiError extends Error { constructor(public code: string, msg: string) { super(msg); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(API_URL + path, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.details?.fieldErrors;
    const first = detail && Object.entries(detail).map(([k, v]) => `${k}: ${(v as string[])[0]}`)[0];
    throw new ApiError(data?.error?.code ?? 'ERROR', first ?? data?.error?.message ?? 'Request failed');
  }
  return data as T;
}

// Prices are stored as integer minor units (paise) to avoid float errors.
export const money = (cents: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(cents / 100);
