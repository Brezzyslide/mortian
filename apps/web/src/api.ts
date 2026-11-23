/**
 * Customer API client. The access token lives in memory only. The refresh token is kept on the
 * phone (localStorage) so customers stay signed in; it rotates on every use and the server
 * revokes the whole session if an old one is replayed.
 */
const REFRESH_KEY = 'app.refresh';
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; reference?: string } | null,
  ) {
    super(body?.error ?? `http_${status}`);
  }
}

function storedRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setSession(t: { accessToken: string; refreshToken: string } | null): void {
  accessToken = t?.accessToken ?? null;
  try {
    if (t) localStorage.setItem(REFRESH_KEY, t.refreshToken);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage blocked: the session lasts until the tab closes */
  }
}

export const hasStoredSession = () => storedRefresh() !== null;

async function doRefresh(): Promise<boolean> {
  // Several tabs share one refresh token: take a cross-tab lock and read the newest token inside it.
  const run = async () => {
    const token = storedRefresh();
    if (!token) return false;
    const r = await fetch('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
    if (!r.ok) {
      if (r.status === 401) setSession(null);
      return false;
    }
    setSession(await r.json());
    return true;
  };
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(REFRESH_KEY, run) : run();
}

export function refresh(): Promise<boolean> {
  refreshing ??= doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  if (!accessToken && !retried && hasStoredSession()) await refresh();
  const r = await fetch(`/v1${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (r.status === 401 && !retried && (await refresh())) return api<T>(path, init, true);
  if (r.status === 204) return undefined as T;
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, json);
  return json as T;
}

export async function logout(): Promise<void> {
  const token = storedRefresh();
  setSession(null);
  if (token) await fetch('/v1/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) }).catch(() => undefined);
}

const MESSAGES: Record<string, string> = {
  otp_invalid: 'That code is not right. Check the SMS and try again.',
  otp_expired: 'That code has expired. Ask for a new one.',
  otp_locked: 'Too many wrong codes. Ask for a new one.',
  rate_limited: 'Too many codes requested. Wait 15 minutes and try again.',
  invalid_phone: 'Enter a Nigerian mobile number, e.g. 0803 123 4567.',
  product_not_live: 'This product is not open for applications right now.',
  profile_incomplete: 'Add your full name first.',
  name_locked: 'Your name is on an approved agreement. Call us to change it.',
  not_withdrawable: 'This application has already been approved. Call us to cancel it.',
  invalid_request: 'Please check what you entered.',
};

export function message(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.body?.error === 'application_open') return `You already have an open application (${err.body.reference}).`;
    return MESSAGES[err.body?.error ?? ''] ?? err.body?.message ?? 'Something went wrong. Please try again.';
  }
  return 'We could not reach the server. Check your connection and try again.';
}
