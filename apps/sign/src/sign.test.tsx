import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

const VIEW = {
  reference: 'FA-000001',
  role: 'borrower',
  signerName: 'Bola Rider',
  phone: '+234 806 *** 0001',
  status: 'open',
  isPlaceholder: true,
  documentText: 'HIRE PURCHASE AGREEMENT FA-000001 …',
  documentSha256: 'a'.repeat(64),
  keyTerms: [
    { key: 'financed', text: 'Amount financed: ₦1,200,000.00' },
    { key: 'total', text: 'Total payable: ₦1,632,000.00' },
  ],
  otpVerified: false,
};

let requests: { path: string; body: Record<string, unknown> }[];
let responder: (path: string, body: Record<string, unknown>) => { status: number; body?: unknown };

beforeEach(() => {
  requests = [];
  sessionStorage.clear();
  localStorage.clear();
  responder = (path) => {
    if (path === 'view') return { status: 200, body: VIEW };
    if (path === 'otp') return { status: 200, body: { sentTo: VIEW.phone } };
    if (path === 'verify') return { status: 204 };
    if (path === 'complete') return { status: 200, body: { status: 'signed', next: 'guarantor' } };
    return { status: 404, body: {} };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace('/v1/sign/', '');
      const body = JSON.parse(String(init.body));
      requests.push({ path, body });
      const r = responder(path, body);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }),
  );
  window.history.pushState({}, '', '/sign/#tok_abcdefghijklmnopqrstuvwxyz0123');
});
// jsdom has no layout: give the agreement box a scrollable size (2000px of text in a 500px box).
const geometry = { scrollHeight: 2000, clientHeight: 500 };
const restore: (() => void)[] = [];
beforeEach(() => {
  for (const [k, v] of Object.entries(geometry)) {
    const prev = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
    restore.push(() => (prev ? Object.defineProperty(HTMLElement.prototype, k, prev) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]));
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  restore.splice(0).forEach((r) => r());
});

describe('signing page', () => {
  it('reads, confirms the SMS code, requires every tick and a name, then signs', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('Your agreement')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('placeholder wording');
    // the token is removed from the address bar but kept for this tab
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('sign.token')).toBe('tok_abcdefghijklmnopqrstuvwxyz0123');

    // cannot continue until the agreement has been scrolled to the end
    expect(screen.getByRole('button', { name: 'Scroll to the end to continue' })).toBeDisabled();
    const doc = screen.getByLabelText('Agreement text');
    Object.defineProperty(doc, 'scrollTop', { configurable: true, value: 1500 });
    fireEvent.scroll(doc);
    await user.click(screen.getByRole('button', { name: 'I have read it, continue' }));
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(screen.getByLabelText('Code from SMS'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const sign = await screen.findByRole('button', { name: 'Sign agreement' });
    expect(sign).toBeDisabled();
    await user.click(screen.getByText('Amount financed: ₦1,200,000.00'));
    await user.click(screen.getByText('Total payable: ₦1,632,000.00'));
    await user.click(screen.getByText('I want to sign this agreement'));
    expect(sign).toBeDisabled(); // name still missing
    await user.type(screen.getByLabelText('Your full name'), 'Bola Rider');
    await user.click(sign);

    expect(await screen.findByRole('status')).toHaveTextContent('Your signature has been recorded');
    expect(screen.getByText(/guarantor will now get their own SMS link/)).toBeInTheDocument();

    const complete = requests.find((r) => r.path === 'complete')!.body;
    expect(complete).toMatchObject({
      token: 'tok_abcdefghijklmnopqrstuvwxyz0123',
      documentSha256: VIEW.documentSha256,
      acknowledged: ['financed', 'total'],
      typedName: 'Bola Rider',
      intentToSign: true,
    });
    expect(String(complete['deviceId'])).toMatch(/^[0-9a-f]{32}$/);
    expect(localStorage.getItem('sign.device')).toBe(complete['deviceId']);
    expect(sessionStorage.getItem('sign.token')).toBeNull();
    // the token never appears in a URL
    expect(requests.every((r) => r.body['token'] === 'tok_abcdefghijklmnopqrstuvwxyz0123')).toBe(true);
  });

  it('explains a guarantor using the borrower’s phone in plain words', async () => {
    const user = userEvent.setup();
    responder = (path) =>
      path === 'view'
        ? { status: 200, body: { ...VIEW, role: 'guarantor', otpVerified: true, keyTerms: [{ key: 'guarantor_liability', text: 'I guarantee up to ₦1,632,000.00' }] } }
        : { status: 403, body: { error: 'same_device_as_borrower' } };
    render(<App />);
    await user.click(await screen.findByText('I guarantee up to ₦1,632,000.00'));
    await user.click(screen.getByText('I want to sign this agreement'));
    await user.type(screen.getByLabelText('Your full name'), 'Gbenga G');
    await user.click(screen.getByRole('button', { name: 'Sign agreement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must sign on their own phone');
  });

  it('shows a clear message for an expired or used link', async () => {
    responder = () => ({ status: 410, body: { error: 'link_invalid' } });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('expired or has already been used');
  });

  it('lets the signer decline with a reason', async () => {
    const user = userEvent.setup();
    responder = (path) => (path === 'view' ? { status: 200, body: VIEW } : { status: 204 });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'I do not want to sign' }));
    await user.type(screen.getByLabelText('Reason'), 'The price is wrong');
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText(/You declined/)).toBeInTheDocument();
    expect(requests.find((r) => r.path === 'decline')!.body).toMatchObject({ reason: 'The price is wrong' });
  });

  it('handles a link opened without its token', async () => {
    window.history.pushState({}, '', '/sign/');
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('link is incomplete');
  });
});
