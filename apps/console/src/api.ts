/**
 * API client. The access token lives only in memory; the refresh token in sessionStorage,
 * so it survives a reload but not closing the tab. A 401 triggers one refresh, then sign-out.
 */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface Claims {
  sub: string;
  kind: 'staff' | 'customer';
  mfa: boolean;
  roles: string[];
  exp: number;
}

const REFRESH_KEY = 'console.refresh';

let accessToken: string | null = null;
let onSignedOut: () => void = () => undefined;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string | string[]; fields?: { path: string; message: string }[] } | null,
  ) {
    super(describe(status, body));
  }
}

function describe(status: number, body: ApiError['body']): string {
  if (body?.fields?.length) return body.fields.map((f) => `${f.path || 'request'}: ${f.message}`).join('; ');
  const m = Array.isArray(body?.message) ? body!.message.join('; ') : body?.message;
  return m || body?.error || `Request failed (${status})`;
}

export function setSignedOutHandler(fn: () => void): void {
  onSignedOut = fn;
}

export function setTokens(t: Tokens | null): void {
  accessToken = t?.accessToken ?? null;
  if (t) sessionStorage.setItem(REFRESH_KEY, t.refreshToken);
  else sessionStorage.removeItem(REFRESH_KEY);
}

export function decodeClaims(token: string): Claims {
  const part = token.split('.')[1] ?? '';
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
  return JSON.parse(json) as Claims;
}

export function currentClaims(): Claims | null {
  return accessToken ? decodeClaims(accessToken) : null;
}

let refreshing: Promise<boolean> | null = null;

/** Exchanges the stored refresh token. Concurrent callers share one request (rotation is single-use). */
export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const rt = sessionStorage.getItem(REFRESH_KEY);
    if (!rt) return false;
    const r = await fetch('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!r.ok) {
      setTokens(null);
      return false;
    }
    setTokens(await r.json());
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const r = await fetch(`/v1${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (r.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, init, true);
    onSignedOut();
  }
  if (r.status === 204) return undefined as T;
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, body);
  return body as T;
}

export async function signOut(): Promise<void> {
  const rt = sessionStorage.getItem(REFRESH_KEY);
  setTokens(null);
  if (rt) await fetch('/v1/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) }).catch(() => undefined);
  onSignedOut();
}
