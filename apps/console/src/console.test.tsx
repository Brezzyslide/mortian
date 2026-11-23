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
    expect(links).toEqual(['Overview', 'Applications', 'Approvals', 'Arrears', 'Tiers', 'Contract templates', 'Products', 'Audit log']);
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

describe('setup link page', () => {
  it('sets a password with the token from the URL fragment, then removes it from the address bar', async () => {
    const user = userEvent.setup();
    let sent: unknown = null;
    handler = (url, init) => {
      if (url === '/v1/auth/staff/setup') {
        sent = JSON.parse(String(init?.body));
        return { status: 200, body: { email: 'new@example.com' } };
      }
      return { status: 401, body: { error: 'session_invalid' } };
    };
    window.history.pushState({}, '', '/console/setup#tok-123456789012345678901234');
    render(<App />);
    await user.type(await screen.findByLabelText('New password'), 'a-long-new-password');
    await user.type(screen.getByLabelText('Repeat it'), 'a-long-new-password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('Password set for new@example.com.')).toBeInTheDocument();
    expect(sent).toEqual({ token: 'tok-123456789012345678901234', password: 'a-long-new-password' });
    expect(window.location.hash).toBe('');
  });

  it('explains an expired or used link in plain words', async () => {
    const user = userEvent.setup();
    handler = (url) =>
      url === '/v1/auth/staff/setup' ? { status: 400, body: { error: 'setup_invalid' } } : { status: 401, body: {} };
    window.history.pushState({}, '', '/console/setup#tok-123456789012345678901234');
    render(<App />);
    await user.type(await screen.findByLabelText('New password'), 'a-long-new-password');
    await user.type(screen.getByLabelText('Repeat it'), 'a-long-new-password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('expired or was already used');
  });

  it('does not call the API when the two passwords differ', async () => {
    const user = userEvent.setup();
    handler = () => ({ status: 401, body: {} });
    window.history.pushState({}, '', '/console/setup#tok-123456789012345678901234');
    render(<App />);
    await user.type(await screen.findByLabelText('New password'), 'a-long-new-password');
    await user.type(screen.getByLabelText('Repeat it'), 'a-different-password');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(calls.some((c) => c.includes('/auth/staff/setup'))).toBe(false);
  });
});

describe('staff screen', () => {
  it('is only in the navigation for super admins, and setup links carry the token in the fragment', async () => {
    const { setupUrl } = await import('./pages/Staff');
    expect(setupUrl('abc')).toBe(`${window.location.origin}/console/setup#abc`);

    sessionStorage.setItem('console.refresh', 'r');
    handler = (url) => {
      if (url === '/v1/auth/refresh') {
        return { status: 200, body: { accessToken: jwt({ sub: 's', kind: 'staff', mfa: true, roles: ['super_admin'] }), refreshToken: 'r2' } };
      }
      if (url === '/v1/admin/lending/approvals') return { status: 200, body: { pending: [] } };
      if (url.startsWith('/v1/admin/lending/accounts')) return { status: 200, body: { accounts: [] } };
      if (url === '/v1/admin/lending/portfolio') return { status: 200, body: { asOf: 'x', buckets: {}, principalOutstanding: '0', par30Percent: 0 } };
      return { status: 200, body: {} };
    };
    render(<App />);
    const nav = await screen.findByRole('navigation');
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toContain('Staff');
  });
});

describe('contract screens', () => {
  const signedIn = (roles: string[], sub = 'mgr') => (url: string) =>
    url === '/v1/auth/refresh'
      ? { status: 200, body: { accessToken: jwt({ sub, kind: 'staff', mfa: true, roles }), refreshToken: 'r2' } }
      : undefined;

  const contract = (over: Record<string, unknown> = {}) => ({
    id: 'c-1',
    status: 'partially_signed',
    documentSha256: 'b'.repeat(64),
    isPlaceholder: true,
    issuedAt: '2026-11-20T10:00:00Z',
    executedAt: null,
    certificateSha256: null,
    closedReason: null,
    documentKey: null,
    signers: [
      { order: 1, role: 'borrower', name: 'Bola Rider', phone: '+234 806 *** 0001', status: 'signed', signedAt: '2026-11-20T11:00:00Z' },
      { order: 2, role: 'guarantor', name: 'Gbenga G', phone: '+234 803 *** 0002', status: 'signed', signedAt: '2026-11-20T12:00:00Z' },
      { order: 3, role: 'company', name: 'Company', phone: null, status: 'open', signedAt: null },
    ],
    flags: ['flag_same_network_as_borrower'],
    ...over,
  });

  async function renderAccount(roles: string[], c: ReturnType<typeof contract>) {
    sessionStorage.setItem('console.refresh', 'r');
    const auth = signedIn(roles);
    handler = (url, init) => {
      const a = auth(url);
      if (a) return a;
      if (url === '/v1/admin/lending/accounts/FA-000001')
        return { status: 200, body: {
            reference: 'FA-000001', status: 'contracted', productCode: 'motorcycle_ride_to_own', credit: '0',
            customer: { fullName: 'Bola', phone: '+234 806 *** 0001' },
            outstanding: { total: '0', principal: '0', interest: '0', penalty: '0', fees: '0' },
            next: null, missed: { instalments: 0, amount: '0', daysOverdue: 0 }, arrears: null, schedule: [],
          } };
      if (url === '/v1/admin/contracts/accounts/FA-000001') return { status: 200, body: { contracts: [c] } };
      if (url === '/v1/admin/contracts/accounts/FA-000001/guarantors') return { status: 200, body: { guarantors: [] } };
      if (url === '/v1/admin/contracts/c-1/countersign' && init?.method === 'POST') return { status: 200, body: { status: 'fully_executed' } };
      return { status: 200, body: {} };
    };
    window.history.pushState({}, '', '/console/accounts/FA-000001');
    render(<App />);
    await screen.findByText('Bola Rider');
  }

  it('a manager countersigns on the company’s turn and sees independence flags', async () => {
    vi.stubGlobal('confirm', () => true);
    const user = userEvent.setup();
    await renderAccount(['manager'], contract());
    expect(screen.getByText(/same network as the borrower/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Countersign for the company' }));
    await waitFor(() => expect(calls).toContain('POST /v1/admin/contracts/c-1/countersign'));
  });

  it('an underwriter cannot countersign or revoke', async () => {
    await renderAccount(['underwriter'], contract());
    expect(screen.queryByRole('button', { name: 'Countersign for the company' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('offers the signed PDF only once the agreement is executed', async () => {
    await renderAccount(['manager'], contract({ status: 'fully_executed', pdfKey: 'k.pdf', flags: [] }));
    expect(screen.getByRole('button', { name: 'Signed PDF' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Countersign for the company' })).toBeNull();
  });

  it('the author of a template draft cannot approve it; another manager can', async () => {
    const draft = { id: 't-2', version: 2, title: 'HP v2', body: 'x', isPlaceholder: false, status: 'draft', createdBy: 'author', createdAt: '2026-11-20T10:00:00Z', approvedAt: null, legalReviewNote: null };
    for (const [sub, approvable] of [['author', false], ['other', true]] as const) {
      setTokens(null);
      sessionStorage.setItem('console.refresh', 'r');
      const auth = signedIn(['manager'], sub);
      handler = (url) => auth(url) ?? (url.startsWith('/v1/admin/contracts/templates/') ? { status: 200, body: { templates: [draft] } } : { status: 200, body: {} });
      window.history.pushState({}, '', '/console/templates');
      const { unmount } = render(<App />);
      await screen.findByRole('heading', { name: 'v2 · HP v2' });
      expect(!!screen.queryByRole('button', { name: 'Approve this version' })).toBe(approvable);
      unmount();
    }
  });
});
