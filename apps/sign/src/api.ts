/** Signing API client. The link token always goes in the request body, never in a URL. */
export interface KeyTerm {
  key: string;
  text: string;
}

export interface SigningView {
  reference: string;
  role: 'borrower' | 'guarantor' | 'company';
  signerName: string;
  phone: string | null;
  status: string;
  isPlaceholder: boolean;
  documentText: string;
  documentSha256: string;
  keyTerms: KeyTerm[];
  otpVerified: boolean;
}

export class SignError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/v1/sign/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 204) return undefined as T;
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new SignError((json as { error?: string } | null)?.error ?? 'request_failed', r.status);
  return json as T;
}

export const signApi = {
  view: (token: string) => post<SigningView>('view', { token }),
  otp: (token: string) => post<{ sentTo: string }>('otp', { token }),
  verify: (token: string, code: string) => post<void>('verify', { token, code }),
  complete: (body: {
    token: string;
    documentSha256: string;
    acknowledged: string[];
    typedName: string;
    intentToSign: boolean;
    deviceId: string;
    signaturePngBase64?: string;
  }) => post<{ status: 'signed'; next: string }>('complete', body),
  decline: (token: string, reason: string) => post<void>('decline', { token, reason }),
};

const TOKEN_KEY = 'sign.token';
const DEVICE_KEY = 'sign.device';

/**
 * Takes the token from the URL fragment once, keeps it for this tab only, and removes it from
 * the address bar so it is not visible on a shared screen or in a screenshot.
 */
export function takeToken(): string | null {
  const fromHash = window.location.hash.replace(/^#/, '');
  if (fromHash) {
    sessionStorage.setItem(TOKEN_KEY, fromHash);
    window.history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export function forgetToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** A random id that stays on this phone. The server stores only its hash, to tell devices apart. */
export function deviceId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    /* storage blocked: fall back to a per-session id */
  }
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

export const MESSAGES: Record<string, string> = {
  link_invalid: 'This link has expired or has already been used. Ask us to send you a new one.',
  otp_invalid: 'That code is not right. Check the SMS and try again.',
  otp_locked: 'Too many wrong codes. Ask for a new code.',
  otp_required: 'Please confirm the code we sent by SMS first.',
  otp_rate_limited: 'Too many codes requested. Wait 15 minutes and try again.',
  document_changed: 'The agreement changed while you were reading. Reload the page to see the latest version.',
  terms_not_acknowledged: 'Please tick every item before signing.',
  signature_missing: 'Type your full name to sign.',
  same_device_as_borrower:
    'A guarantor must sign on their own phone. This phone was used by the borrower, so we cannot accept the signature here.',
  device_required: 'This phone did not send its device check. Reload the page and try again.',
};

export function message(err: unknown): string {
  if (err instanceof SignError) return MESSAGES[err.code] ?? 'Something went wrong. Please try again.';
  return 'We could not reach the server. Check your connection and try again.';
}
