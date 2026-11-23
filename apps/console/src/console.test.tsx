import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, setTokens } from './api';
import { App } from './App';
import { naira, toKobo } from './format';

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: 9_999_999_999, ...claims })}.sig`;
}

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown };
let handler: Handler;
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  sessionStorage.clear();
  setTokens(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const r = handler(url, init);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }),
  );
  window.history.pushState({}, '', '/console/');
});
afterEach(() => vi.unstubAllGlobals());

describe('money formatting', () => {
  it('shows kobo strings as naira without float error', () => {
    expect(naira('9007199254740993')).toBe('₦90,071,992,547,409.93');
    expect(naira('150000000')).toBe('₦1,500,000.00');
    expect(naira(null)).toBe('—');
  });

  it('parses naira input to kobo and rejects ambiguity', () => {
    expect(toKobo('1,500,000')).toBe('150000000');
    expect(toKobo('₦ 31,384.61')).toBe('3138461');
    expect(() => toKobo('12.345')).toThrow();
    expect(() => toKobo('0')).toThrow();
    expect(() => toKobo('abc')).toThrow();
  });
});

describe('token refresh', () => {
  it('refreshes once on 401, retries, and shares one refresh across concurrent calls', async () => {
    setTokens({ accessToken: 'old', refreshToken: 'r1' });
    let refreshes = 0;
    handler = (url, init) => {
      if (url === '/v1/auth/refresh') {
        refreshes++;
        return { status: 200, body: { accessToken: 'new', refreshToken: 'r2' } };
      }
      const auth = (init?.headers as Record<string, string>)['authorization'];
      return auth === 'Bearer new' ? { status: 200, body: { ok: true } } : { status: 401, body: { error: 'session_invalid' } };
    };
    const results = await Promise.all([api('/me'), api('/me'), api('/me')]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(sessionStorage.getItem('console.refresh')).toBe('r2');
  });
});

describe('staff sign-in and navigation', () => {
  it('walks through authenticator enrolment, then shows only the screens the roles allow', async () => {
    const user = userEvent.setup();
    handler = (url) => {
      if (url === '/v1/auth/refresh') return { status: 401, body: { error: 'session_invalid' } };
      if (url === '/v1/auth/staff/login') {
        return {
          status: 200,
          body: {
            challengeId: 'c1',
            enrolmentRequired: true,
            enrolment: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/X:a@b.com?secret=JBSWY3DPEHPK3PXP' },
          },
        };
      }
      if (url === '/v1/auth/staff/mfa') {
        return { status: 200, body: { accessToken: jwt({ sub: 'u1', kind: 'staff', mfa: true, roles: ['manager'] }), refreshToken: 'r' } };
      }
      if (url.startsWith('/v1/admin/lending/approvals')) return { status: 200, body: { pending: [] } };
      if (url.startsWith('/v1/admin/lending/portfolio')) {
        return { status: 200, body: { asOf: '2026-11-23', buckets: {}, principalOutstanding: '0', par30Percent: 0 } };
      }
      return { status: 200, body: {} };
    };

    render(<App />);
    await user.type(await screen.findByLabelText('Email'), 'mgr@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const nav = await screen.findByRole('navigation');
    const links = within(nav).getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(['Overview', 'Applications', 'Approvals', 'Arrears', 'Tiers', 'Products', 'Audit log']);
    expect(links).not.toContain('Payment exceptions'); // finance only
    expect(sessionStorage.getItem('console.refresh')).toBe('r');
  });

  it('shows the API error for a wrong password', async () => {
    const user = userEvent.setup();
    handler = (url) =>
      url === '/v1/auth/staff/login'
        ? { status: 401, body: { error: 'invalid_credentials' } }
        : { status: 401, body: { error: 'session_invalid' } };
    render(<App />);
    await user.type(await screen.findByLabelText('Email'), 'x@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid_credentials');
  });

  it('refuses customer sessions', async () => {
    sessionStorage.setItem('console.refresh', 'r');
    handler = (url) =>
      url === '/v1/auth/refresh'
        ? { status: 200, body: { accessToken: jwt({ sub: 'c', kind: 'customer', mfa: false, roles: ['customer'] }), refreshToken: 'r2' } }
        : { status: 200, body: {} };
    render(<App />);
    expect(await screen.findByText('This console is for staff accounts only.')).toBeInTheDocument();
  });

  it('a finance user sees payment exceptions and the portfolio, not approvals', async () => {
    sessionStorage.setItem('console.refresh', 'r');
    handler = (url) => {
      if (url === '/v1/auth/refresh') {
        return { status: 200, body: { accessToken: jwt({ sub: 'f', kind: 'staff', mfa: true, roles: ['finance'] }), refreshToken: 'r2' } };
      }
      if (url.startsWith('/v1/admin/lending/portfolio')) {
        return {
          status: 200,
          body: {
            asOf: '2026-11-23',
            buckets: { current: { accounts: 3, principal: '360000000' } },
            principalOutstanding: '360000000',
            par30Percent: 0,
          },
        };
      }
      return { status: 200, body: {} };
    };
    render(<App />);
    expect(await screen.findByText('₦3,600,000.00', { selector: '.v' })).toBeInTheDocument();
    const links = within(screen.getByRole('navigation')).getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(['Overview', 'Payment exceptions']);
    await waitFor(() => expect(calls.some((c) => c.includes('/admin/lending/approvals'))).toBe(false));
  });
});
