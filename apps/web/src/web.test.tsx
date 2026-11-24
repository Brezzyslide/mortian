import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { setSession } from './api';

type Reply = { status: number; body?: unknown };
let handler: (path: string, init: RequestInit) => Reply | undefined;
let calls: { method: string; path: string; body: unknown; auth: string | null }[];
const uploads: { path: string; type: string; size: number }[] = [];

beforeEach(() => {
  calls = [];
  localStorage.clear();
  setSession(null);
  window.history.pushState({}, '', '/app/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('/v1', '');
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method ?? 'GET', path, body, auth: (init.headers as Record<string, string> | undefined)?.authorization ?? null });
      if (init.body instanceof Blob) uploads.push({ path, type: (init.headers as Record<string, string>)['content-type']!, size: init.body.size });
      const r = handler(path, init) ?? { status: 404, body: { error: 'not_found' } };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }),
  );
});

const ME = { id: 'p1', kind: 'customer', phone: '+2348061234567', fullName: 'Bola Rider' };

const STATEMENT = {
  reference: 'FA-000007',
  status: 'repossession_review',
  isPlaceholderTerms: false,
  outstanding: { principal: '90000000', interest: '10000000', fees: '0', penalty: '500000', total: '100500000' },
  credit: '0',
  missed: { instalments: 3, amount: '9415383', oldestDueDate: '2026-11-01', daysOverdue: 22 },
  next: { dueDate: '2026-11-29', amount: '3138461' },
  paidOffPercent: 30,
  schedule: [
    { seq: 1, dueDate: '2026-11-01', principal: '2500000', interest: '638461', paid: '0', state: 'missed' },
    { seq: 2, dueDate: '2026-11-29', principal: '2500000', interest: '638461', paid: '0', state: 'upcoming' },
  ],
  arrears: {
    reactivationAmount: '9915383',
    penaltyOutstanding: '500000',
    cureDeadline: '2026-12-07',
    reviewStartsOn: null,
    steps: [
      { code: 'pay_to_reactivate', text: 'Pay ₦99,153.83 to Sandbox Bank account 9900000007 by 2026-12-07.' },
      { code: 'automatic_return', text: 'When the full amount arrives, your account returns to active automatically.' },
    ],
  },
  repaymentAccount: { accountNumber: '9900000007', bankName: 'Sandbox Bank' },
};

describe('customer app', () => {
  it('first visit: sign in by SMS code, give a name, apply, and see the reference', async () => {
    const user = userEvent.setup();
    let named = false;
    handler = (path, init) => {
      if (path === '/auth/otp/request') return { status: 200, body: { challengeId: 'c1', sentTo: '+234 806 *** 4567' } };
      if (path === '/auth/otp/verify') return { status: 200, body: { accessToken: 'a1', refreshToken: 'r'.repeat(40) } };
      if (path === '/me') return { status: 200, body: { ...ME, fullName: named ? 'Bola Rider' : null } };
      if (path === '/me/profile') return (named = true), { status: 200, body: { fullName: 'Bola Rider' } };
      if (path === '/me/accounts') return { status: 200, body: { accounts: [] } };
      if (path === '/me/products')
        return { status: 200, body: { products: [{ productCode: 'motorcycle_ride_to_own', name: 'Motorcycle ride-to-own', summary: 'Ride and own.' }] } };
      if (path === '/me/applications' && init.method === 'POST')
        return { status: 201, body: { reference: 'FA-000007', status: 'applied', repaymentAccount: { accountNumber: '9900000007', bankName: 'Sandbox Bank' } } };
      return undefined;
    };
    render(<App />);
    await user.type(await screen.findByLabelText('Phone number'), '0806 123 4567');
    await user.click(screen.getByRole('button', { name: 'Send me a code' }));
    await user.type(await screen.findByLabelText('Code from SMS'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // must give a full name before anything else
    const name = await screen.findByLabelText('Full name');
    await user.type(name, 'Bola');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.type(name, ' Rider');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Hello, Bola')).toBeInTheDocument();
    expect(localStorage.getItem('app.refresh')).toBe('r'.repeat(40));
    await user.click(screen.getByRole('button', { name: 'Apply for something new' }));
    expect(window.location.pathname).toBe('/app/apply');
    await user.click(await screen.findByText('Motorcycle ride-to-own'));
    await user.click(screen.getByRole('button', { name: 'Send application' }));
    expect(await screen.findByRole('status')).toHaveTextContent('FA-000007');
    expect(screen.getByText(/Do not pay anything until your agreement is signed/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/me/applications')).toMatchObject({ auth: 'Bearer a1', body: { productCode: 'motorcycle_ride_to_own' } });
  });

  it('an account at risk shows how much to pay, by when, and where', async () => {
    setSession({ accessToken: 'a1', refreshToken: 'r'.repeat(40) });
    handler = (path) =>
      path === '/me' ? { status: 200, body: ME } : path === '/me/accounts/FA-000007' ? { status: 200, body: STATEMENT } : undefined;
    window.history.pushState({}, '', '/app/accounts/FA-000007');
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('₦99,153.83');
    expect(alert).toHaveTextContent('3 missed, 22 days overdue');
    expect(alert).toHaveTextContent('Includes ₦5,000.00 penalty interest');
    expect(alert).toHaveTextContent('by 2026-12-07');
    expect(screen.getByText('At risk')).toBeInTheDocument();
    expect(screen.getByText('9900000007')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw this application' })).toBeNull();
  });

  it('withdraws an application that is still under review', async () => {
    const user = userEvent.setup();
    setSession({ accessToken: 'a1', refreshToken: 'r'.repeat(40) });
    let st = { ...STATEMENT, status: 'applied', arrears: null, schedule: [], missed: { instalments: 0, amount: '0', oldestDueDate: null, daysOverdue: 0 } };
    handler = (path) => {
      if (path === '/me') return { status: 200, body: ME };
      if (path === '/me/accounts/FA-000007') return { status: 200, body: st };
      if (path === '/me/applications/FA-000007/withdraw') return (st = { ...st, status: 'withdrawn' }), { status: 200, body: {} };
      return undefined;
    };
    window.history.pushState({}, '', '/app/accounts/FA-000007');
    render(<App />);
    expect(await screen.findByText(/do not pay until your agreement is signed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Withdraw this application' }));
    expect(await screen.findByText('Withdrawn')).toBeInTheDocument();
    expect(screen.queryByText('9900000007')).toBeNull();
  });

  it('an expired access token is refreshed once and the request retried', async () => {
    localStorage.setItem('app.refresh', 'old'.repeat(10));
    handler = (path, init) => {
      if (path === '/auth/refresh') {
        const sent = JSON.parse(String(init.body)).refreshToken;
        return sent === 'old'.repeat(10) ? { status: 200, body: { accessToken: 'fresh', refreshToken: 'new'.repeat(10) } } : { status: 401, body: {} };
      }
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth !== 'Bearer fresh') return { status: 401, body: { error: 'session_invalid' } };
      if (path === '/me') return { status: 200, body: ME };
      if (path === '/me/accounts') return { status: 200, body: { accounts: [] } };
      return undefined;
    };
    render(<App />);
    expect(await screen.findByText('Hello, Bola')).toBeInTheDocument();
    expect(localStorage.getItem('app.refresh')).toBe('new'.repeat(10));
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });

  it('a revoked session signs the customer out instead of looping', async () => {
    localStorage.setItem('app.refresh', 'dead'.repeat(10));
    handler = (path) => (path === '/auth/refresh' ? { status: 401, body: { error: 'session_reused' } } : { status: 401, body: {} });
    render(<App />);
    expect(await screen.findByLabelText('Phone number')).toBeInTheDocument();
    expect(localStorage.getItem('app.refresh')).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.path === '/auth/refresh').length).toBeLessThanOrEqual(1));
  });

  it('explains a second application for the same product', async () => {
    const user = userEvent.setup();
    setSession({ accessToken: 'a1', refreshToken: 'r'.repeat(40) });
    handler = (path) => {
      if (path === '/me') return { status: 200, body: ME };
      if (path === '/me/products') return { status: 200, body: { products: [{ productCode: 'phone_financing', name: 'Phone on instalments', summary: 'x' }] } };
      if (path === '/me/applications') return { status: 409, body: { error: 'application_open', reference: 'FA-000003' } };
      return undefined;
    };
    window.history.pushState({}, '', '/app/apply');
    render(<App />);
    await user.click(await screen.findByText('Phone on instalments'));
    await user.click(screen.getByRole('button', { name: 'Send application' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have an open application (FA-000003).');
  });
});

describe('before handover', () => {
  it('shows the agreed terms and how much deposit is left once the agreement is signed', async () => {
    setSession({ accessToken: 'a1', refreshToken: 'r'.repeat(40) });
    const st = {
      ...STATEMENT,
      status: 'contracted',
      arrears: null,
      schedule: [],
      missed: { instalments: 0, amount: '0', oldestDueDate: null, daysOverdue: 0 },
      terms: { assetPrice: '150000000', deposit: '30000000', financed: '120000000', firstInstalment: '3138461', instalments: 52, frequency: 'weekly', instalmentsTotal: '163199972', totalCost: '193199972', annualInterestBps: 3600, interestMethod: 'flat' },
      deposit: { required: '30000000', paid: '10000000', remaining: '20000000' },
      asset: { description: 'Bajaj Boxer 2026', idKind: 'chassis', identifier: 'MD2A12BZ7LC000111', plateNumber: 'KUJ123AB' },
    };
    handler = (path) => (path === '/me' ? { status: 200, body: ME } : path === '/me/accounts/FA-000007' ? { status: 200, body: st } : undefined);
    window.history.pushState({}, '', '/app/accounts/FA-000007');
    render(<App />);
    expect(await screen.findByText(/Pay ₦200,000.00 into the account below/)).toBeInTheDocument();
    expect(screen.getByText('52 × ₦31,384.61 a week')).toBeInTheDocument();
    expect(screen.getByText('₦1,931,999.72')).toBeInTheDocument();
    expect(screen.getByText('36% a year (flat)')).toBeInTheDocument();
    expect(screen.getByText(/Plate KUJ123AB/)).toBeInTheDocument();
  });

  it('uploads an ID photo as the raw file and shows why an earlier one was not accepted', async () => {
    const user = userEvent.setup();
    setSession({ accessToken: 'a1', refreshToken: 'r'.repeat(40) });
    uploads.length = 0;
    let docs = [{ id: 'd1', kind: 'national_id', status: 'rejected', uploadedAt: '2026-11-24T09:00:00Z', reviewNote: 'Photo is blurred' }];
    handler = (path, init) => {
      if (path === '/me') return { status: 200, body: ME };
      if (path === '/me/accounts') return { status: 200, body: { accounts: [] } };
      if (path === '/me/documents') return { status: 200, body: { documents: docs } };
      if (path === '/me/documents?kind=drivers_licence' && init.method === 'POST') {
        docs = [{ id: 'd2', kind: 'drivers_licence', status: 'submitted', uploadedAt: '2026-11-24T10:00:00Z', reviewNote: null }, ...docs] as typeof docs;
        return { status: 201, body: docs[0] };
      }
      return undefined;
    };
    render(<App />);
    expect(await screen.findByText(/Photo is blurred. Please upload a new one./)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Document'), 'drivers_licence');
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'licence.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Photo or PDF'), photo);
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Uploaded. We will check it.')).toBeInTheDocument();
    expect(uploads).toEqual([{ path: '/me/documents?kind=drivers_licence', type: 'image/jpeg', size: 7 }]);
    expect(await screen.findByText('Being checked')).toBeInTheDocument();
  });
});
