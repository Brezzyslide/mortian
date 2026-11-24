import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { brand, formatNaira, kobo } from '@project/domain';
import { api, ApiError, hasStoredSession, logout, message, setSession, uploadFile } from './api';
import { shrinkImage } from './shrink';

// ---------------- types ----------------

interface Me {
  id: string;
  kind: string;
  phone: string | null;
  fullName: string | null;
}
interface Product {
  productCode: string;
  name: string;
  summary: string;
}
interface AccountSummary {
  reference: string;
  productCode: string;
  productName: string;
  status: string;
  outstanding: string;
  missed: { instalments: number; amount: string; daysOverdue: number };
  next: { dueDate: string; amount: string } | null;
  paidOffPercent: number;
}
interface Statement {
  reference: string;
  status: string;
  isPlaceholderTerms: boolean;
  outstanding: { principal: string; interest: string; fees: string; penalty: string; total: string };
  credit: string;
  missed: { instalments: number; amount: string; oldestDueDate: string | null; daysOverdue: number };
  next: { dueDate: string; amount: string } | null;
  paidOffPercent: number;
  schedule: { seq: number; dueDate: string; principal: string; interest: string; paid: string; state: string }[];
  arrears: {
    reactivationAmount: string;
    penaltyOutstanding: string;
    cureDeadline: string | null;
    reviewStartsOn: string | null;
    steps: { code: string; text: string }[];
  } | null;
  repaymentAccount: { accountNumber: string; bankName: string } | null;
  terms: {
    assetPrice: string;
    deposit: string;
    financed: string;
    firstInstalment: string;
    instalments: number;
    frequency: string;
    instalmentsTotal: string;
    totalCost: string;
    annualInterestBps: number;
    interestMethod: string;
  } | null;
  deposit: { required: string; paid: string; remaining: string } | null;
  asset: { description: string; idKind: string; identifier: string; plateNumber: string | null } | null;
}
interface Doc {
  id: string;
  kind: string;
  status: 'submitted' | 'accepted' | 'rejected';
  uploadedAt: string;
  reviewNote: string | null;
}

const naira = (amount: string) => formatNaira(kobo(BigInt(amount)));
const date = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

/** What each status means for the customer, in plain words. */
export const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; explain: string }> = {
  applied: { label: 'Under review', tone: 'neutral', explain: 'We have your application. Our team will review it and contact you.' },
  approved: { label: 'Approved', tone: 'good', explain: 'You will get an SMS with a link to read and sign your agreement.' },
  contracted: { label: 'Agreement signed', tone: 'good', explain: 'Pay your deposit to the account below. We will then arrange handover.' },
  deposit_paid: { label: 'Deposit paid', tone: 'good', explain: 'We will contact you to arrange handover.' },
  active: { label: 'Active', tone: 'good', explain: 'Keep paying on time to own it.' },
  in_arrears: { label: 'Payment missed', tone: 'warn', explain: 'You have missed a payment. Pay the amount below to catch up.' },
  repossession_review: { label: 'At risk', tone: 'bad', explain: 'Your account is in repossession review. Pay the amount below to keep it.' },
  repossessed: { label: 'Repossessed', tone: 'bad', explain: 'The asset has been recovered. You can still reactivate by paying the amount below.' },
  closed_recovered: { label: 'Closed', tone: 'neutral', explain: 'This account is closed.' },
  settled: { label: 'Paid off', tone: 'good', explain: 'You have paid in full. Well done.' },
  title_transferred: { label: 'Yours', tone: 'good', explain: 'Paid in full and transferred to you.' },
  declined: { label: 'Not approved', tone: 'neutral', explain: 'This application was not approved.' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral', explain: 'You withdrew this application.' },
  written_off: { label: 'Closed', tone: 'neutral', explain: 'This account is closed. Call us to discuss it.' },
};
const status = (s: string) => STATUS[s] ?? { label: s, tone: 'neutral' as const, explain: '' };

// ---------------- routing (no library: three screens) ----------------

type Route = { name: 'home' } | { name: 'apply' } | { name: 'account'; reference: string };

function parse(path: string): Route {
  const m = /^\/app\/accounts\/(FA-\d{6,})$/.exec(path);
  if (m) return { name: 'account', reference: m[1]! };
  if (path === '/app/apply') return { name: 'apply' };
  return { name: 'home' };
}

function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState(() => parse(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const go = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(parse(path));
    window.scrollTo?.(0, 0);
  }, []);
  return [route, go];
}

// ---------------- app ----------------

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(hasStoredSession() ? undefined : null);
  const [route, go] = useRoute();

  const loadMe = useCallback(() => {
    api<Me>('/me')
      .then((m) => setMe(m.kind === 'customer' ? m : null))
      .catch(() => setMe(null));
  }, []);
  useEffect(() => {
    if (me === undefined) loadMe();
  }, [me, loadMe]);

  let body: ReactNode;
  if (me === undefined) body = <p className="muted">Loading…</p>;
  else if (me === null) body = <SignIn onDone={loadMe} />;
  else if (!me.fullName) body = <NameStep onDone={(fullName) => setMe({ ...me, fullName })} />;
  else if (route.name === 'apply') body = <Apply go={go} />;
  else if (route.name === 'account') body = <Account reference={route.reference} go={go} />;
  else body = <Home me={me} go={go} />;

  return (
    <main>
      <header>
        <strong onClick={() => me && go('/app/')}>{brand.name}</strong>
        {me && (
          <button className="link" onClick={() => void logout().then(() => setMe(null))}>
            Sign out
          </button>
        )}
      </header>
      {body}
      <footer className="muted">
        Help: {brand.supportPhone} · {brand.supportEmail}
      </footer>
    </main>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const ErrorBox = ({ error }: { error: string | null }) => (error ? <div className="error" role="alert">{error}</div> : null);

// ---------------- sign in ----------------

function SignIn({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; sentTo: string } | null>(null);
  const [code, setCode] = useState('');
  const a = useAction();

  const request = () =>
    a.run(async () => {
      const r = await api<{ challengeId: string; sentTo: string }>('/auth/otp/request', { body: { phone } });
      setChallenge({ id: r.challengeId, sentTo: r.sentTo });
      setCode('');
    });

  return (
    <section>
      <h1>Sign in</h1>
      {!challenge ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void request();
          }}
        >
          <label>
            Phone number
            <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0803 123 4567" required />
          </label>
          <button disabled={a.busy || phone.replace(/\D/g, '').length < 10}>Send me a code</button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              setSession(await api('/auth/otp/verify', { body: { challengeId: challenge.id, code } }));
              onDone();
            });
          }}
        >
          <p>We sent a 6-digit code to {challenge.sentTo}.</p>
          <label>
            Code from SMS
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </label>
          <button disabled={a.busy || code.length !== 6}>Sign in</button>
          <button type="button" className="link" disabled={a.busy} onClick={() => void request()}>
            Send a new code
          </button>
          <button type="button" className="link" onClick={() => setChallenge(null)}>
            Use a different number
          </button>
        </form>
      )}
      <ErrorBox error={a.error} />
    </section>
  );
}

function NameStep({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const a = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => onDone((await api<{ fullName: string }>('/me/profile', { body: { fullName: name } })).fullName));
      }}
    >
      <h1>Your name</h1>
      <p>Enter your full name exactly as it is on your ID. It goes on your agreement.</p>
      <label>
        Full name
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="First and last name" required />
      </label>
      <button disabled={a.busy || !name.trim().includes(' ')}>Continue</button>
      <ErrorBox error={a.error} />
    </form>
  );
}

// ---------------- home ----------------

function Home({ me, go }: { me: Me; go: (p: string) => void }) {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ accounts: AccountSummary[] }>('/me/accounts')
      .then((r) => setAccounts(r.accounts))
      .catch((e) => setError(message(e)));
  }, []);

  return (
    <section>
      <h1>Hello, {me.fullName?.split(' ')[0]}</h1>
      <ErrorBox error={error} />
      {accounts === null && !error && <p className="muted">Loading your accounts…</p>}
      {accounts?.length === 0 && <p>You have no accounts yet.</p>}
      {accounts?.map((a) => {
        const s = status(a.status);
        return (
          <button key={a.reference} className="card" onClick={() => go(`/app/accounts/${a.reference}`)}>
            <div className="row">
              <strong>{a.productName}</strong>
              <span className={`badge ${s.tone}`}>{s.label}</span>
            </div>
            <div className="muted small">{a.reference}</div>
            {a.missed.instalments > 0 && (
              <div className="warn small">
                Missed {a.missed.instalments} payment{a.missed.instalments > 1 ? 's' : ''}: {naira(a.missed.amount)} ({a.missed.daysOverdue} days overdue)
              </div>
            )}
            {a.next && a.missed.instalments === 0 && (
              <div className="small">
                Next: {naira(a.next.amount)} on {date(a.next.dueDate)}
              </div>
            )}
            {BigInt(a.outstanding) > 0n && <div className="small muted">Left to pay: {naira(a.outstanding)}</div>}
          </button>
        );
      })}
      <button onClick={() => go('/app/apply')}>Apply for something new</button>
      <Documents />
    </section>
  );
}

const DOC_KIND: Record<string, string> = {
  national_id: 'National ID / NIN slip',
  drivers_licence: "Driver's licence",
  voters_card: "Voter's card",
  passport: 'International passport',
  proof_of_address: 'Proof of address (utility bill)',
  other: 'Other',
};
const DOC_STATUS: Record<Doc['status'], { label: string; tone: string }> = {
  submitted: { label: 'Being checked', tone: 'neutral' },
  accepted: { label: 'Accepted', tone: 'good' },
  rejected: { label: 'Not accepted', tone: 'bad' },
};
const PER: Record<string, string> = { daily: 'day', weekly: 'week', fortnightly: 'fortnight', monthly: 'month' };

/** ID and proof of address: what was sent, what was accepted, and why anything was not. */
function Documents() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [kind, setKind] = useState('national_id');
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState(false);
  const a = useAction();
  const load = useCallback(() => {
    api<{ documents: Doc[] }>('/me/documents').then((r) => setDocs(r.documents)).catch(() => setDocs([]));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="panel">
      <h2>Your documents</h2>
      <p className="small muted">We need a photo of your ID before we can approve an application. Make sure all four corners and the text are clear.</p>
      {docs?.map((d) => (
        <div key={d.id} className="doc-row">
          <div className="row">
            <span>{DOC_KIND[d.kind] ?? d.kind}</span>
            <span className={`badge ${DOC_STATUS[d.status].tone}`}>{DOC_STATUS[d.status].label}</span>
          </div>
          {d.status === 'rejected' && d.reviewNote && <div className="small bad-text">{d.reviewNote}. Please upload a new one.</div>}
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return;
          void a.run(async () => {
            await uploadFile(`/me/documents?kind=${kind}`, await shrinkImage(file));
            setFile(null);
            setSent(true);
            (e.target as HTMLFormElement).reset();
            load();
          });
        }}
      >
        <label>
          Document
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(DOC_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Photo or PDF
          <input type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setSent(false))} />
        </label>
        <button disabled={a.busy || !file}>{a.busy ? 'Uploading…' : 'Upload'}</button>
      </form>
      {sent && <div className="ok small">Uploaded. We will check it.</div>}
      <ErrorBox error={a.error} />
    </div>
  );
}

function TermsPanel({ t }: { t: NonNullable<Statement['terms']> }) {
  const rate = `${(t.annualInterestBps / 100).toFixed(2).replace(/\.00$/, '')}% a year (${t.interestMethod === 'flat' ? 'flat' : 'reducing balance'})`;
  return (
    <div className="panel">
      <h2>Your terms</h2>
      <div className="row"><span>Price</span><strong>{naira(t.assetPrice)}</strong></div>
      <div className="row"><span>Deposit</span><strong>{naira(t.deposit)}</strong></div>
      <div className="row"><span>Financed</span><strong>{naira(t.financed)}</strong></div>
      <div className="row">
        <span>Repayments</span>
        <strong>
          {t.instalments} × {naira(t.firstInstalment)} a {PER[t.frequency] ?? t.frequency}
        </strong>
      </div>
      <div className="row"><span>Interest</span><span>{rate}</span></div>
      <div className="row"><span>Total you pay</span><strong>{naira(t.totalCost)}</strong></div>
      <div className="small muted">Deposit plus all repayments. Late payments add penalty interest. Your agreement has the full terms.</div>
    </div>
  );
}

// ---------------- apply ----------------

function Apply({ go }: { go: (p: string) => void }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [chosen, setChosen] = useState<Product | null>(null);
  const [done, setDone] = useState<{ reference: string; repaymentAccount: { accountNumber: string; bankName: string } } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const a = useAction();
  useEffect(() => {
    api<{ products: Product[] }>('/me/products')
      .then((r) => setProducts(r.products))
      .catch((e) => setLoadError(message(e)));
  }, []);

  if (done)
    return (
      <section>
        <div className="ok" role="status">
          Application sent. Your reference is <strong>{done.reference}</strong>.
        </div>
        <p>Our team will review it and contact you. Do not pay anything until your agreement is signed.</p>
        <button onClick={() => go(`/app/accounts/${done.reference}`)}>See your application</button>
      </section>
    );

  return (
    <section>
      <h1>Apply</h1>
      {products?.length === 0 && <p>Nothing is open for applications right now. Please check back soon.</p>}
      {!chosen &&
        products?.map((p) => (
          <button key={p.productCode} className="card" onClick={() => setChosen(p)}>
            <strong>{p.name}</strong>
            <span className="small muted">{p.summary}</span>
          </button>
        ))}
      {chosen && (
        <div className="panel">
          <h2>{chosen.name}</h2>
          <p>{chosen.summary}</p>
          <p className="small muted">Our team sets your price and terms after review. You see everything before you sign.</p>
          <button
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => setDone(await api('/me/applications', { body: { productCode: chosen.productCode } })))
            }
          >
            Send application
          </button>
          <button className="link" onClick={() => setChosen(null)}>
            Choose something else
          </button>
        </div>
      )}
      <ErrorBox error={a.error ?? loadError} />
      <button className="link" onClick={() => go('/app/')}>
        Back
      </button>
    </section>
  );
}

// ---------------- account ----------------

function Account({ reference, go }: { reference: string; go: (p: string) => void }) {
  const [st, setSt] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const a = useAction();
  const load = useCallback(() => {
    api<Statement>(`/me/accounts/${reference}`)
      .then(setSt)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? 'Account not found.' : message(e)));
  }, [reference]);
  useEffect(load, [load]);

  if (error)
    return (
      <section>
        <ErrorBox error={error} />
        <button className="link" onClick={() => go('/app/')}>
          Back
        </button>
      </section>
    );
  if (!st) return <p className="muted">Loading…</p>;
  const s = status(st.status);
  const upcoming = st.schedule.filter((i) => i.state !== 'paid');
  const rows = showAll ? st.schedule : upcoming.slice(0, 6);

  return (
    <section>
      <button className="link" onClick={() => go('/app/')}>
        ← All accounts
      </button>
      <div className="row">
        <h1>{st.reference}</h1>
        <span className={`badge ${s.tone}`}>{s.label}</span>
      </div>
      <p>{s.explain}</p>
      {st.isPlaceholderTerms && <div className="warn">Test terms. This is not a real agreement.</div>}

      {st.deposit && (
        <div className="panel">
          <h2>Deposit</h2>
          <div className="row"><span>Deposit</span><strong>{naira(st.deposit.required)}</strong></div>
          <div className="row"><span>Paid so far</span><strong>{naira(st.deposit.paid)}</strong></div>
          <div className="row"><span>Left to pay</span><strong>{naira(st.deposit.remaining)}</strong></div>
          <div className="small">
            {st.status === 'approved'
              ? 'Sign your agreement first (we will text you the link). Then pay the deposit into the account below.'
              : BigInt(st.deposit.remaining) > 0n
                ? `Pay ${naira(st.deposit.remaining)} into the account below. We will contact you to arrange handover once it arrives.`
                : 'Deposit paid. We will contact you to arrange handover.'}
          </div>
        </div>
      )}
      {st.terms && <TermsPanel t={st.terms} />}
      {st.asset && (
        <div className="panel">
          <h2>Your {st.asset.idKind === 'imei' ? 'phone' : 'asset'}</h2>
          <div>{st.asset.description}</div>
          <div className="small muted">
            {st.asset.idKind === 'chassis' ? 'Chassis' : st.asset.idKind === 'imei' ? 'IMEI' : 'Serial'} {st.asset.identifier}
            {st.asset.plateNumber && ` · Plate ${st.asset.plateNumber}`}
          </div>
        </div>
      )}

      {st.arrears && (
        <div className={`panel ${st.status === 'in_arrears' ? 'warn-panel' : 'bad-panel'}`} role="alert">
          <div className="big">{naira(st.arrears.reactivationAmount)}</div>
          <div className="small">
            {st.status === 'in_arrears' ? 'to catch up' : 'to reactivate'}
            {st.missed.instalments > 0 && ` · ${st.missed.instalments} missed, ${st.missed.daysOverdue} days overdue`}
          </div>
          {BigInt(st.arrears.penaltyOutstanding) > 0n && <div className="small">Includes {naira(st.arrears.penaltyOutstanding)} penalty interest.</div>}
          <ol>
            {st.arrears.steps.map((x) => (
              <li key={x.code}>{x.text}</li>
            ))}
          </ol>
        </div>
      )}

      {st.repaymentAccount && !['declined', 'withdrawn', 'settled', 'title_transferred', 'written_off'].includes(st.status) && (
        <div className="panel">
          <div className="small muted">{st.status === 'applied' ? 'Your repayment account (do not pay until your agreement is signed)' : 'Pay into'}</div>
          <div className="row">
            <div>
              <div className="big mono">{st.repaymentAccount.accountNumber}</div>
              <div>{st.repaymentAccount.bankName}</div>
            </div>
            <CopyButton text={st.repaymentAccount.accountNumber} />
          </div>
          <div className="small muted">This account is only for {st.reference}. Payments show here within minutes.</div>
        </div>
      )}

      {!['applied', 'approved', 'declined', 'withdrawn'].includes(st.status) && (
        <div className="panel">
          <div className="row">
            <span>Left to pay</span>
            <strong>{naira(st.outstanding.total)}</strong>
          </div>
          {st.next && (
            <div className="row">
              <span>Next payment</span>
              <strong>
                {naira(st.next.amount)} · {date(st.next.dueDate)}
              </strong>
            </div>
          )}
          {BigInt(st.credit) > 0n && (
            <div className="row">
              <span>In credit</span>
              <strong>{naira(st.credit)}</strong>
            </div>
          )}
          <div className="progress" aria-label={`${st.paidOffPercent}% paid`}>
            <div style={{ width: `${Math.min(100, st.paidOffPercent)}%` }} />
          </div>
          <div className="small muted">{st.paidOffPercent}% paid</div>
        </div>
      )}

      {st.schedule.length > 0 && (
        <div className="panel">
          <h2>Payments</h2>
          <table>
            <tbody>
              {rows.map((i) => (
                <tr key={i.seq} className={i.state}>
                  <td>{date(i.dueDate)}</td>
                  <td>{naira((BigInt(i.principal) + BigInt(i.interest)).toString())}</td>
                  <td className="small">{{ paid: 'Paid', part_paid: 'Part paid', missed: 'Missed', due: 'Due', upcoming: '' }[i.state] ?? i.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${st.schedule.length}`}
          </button>
        </div>
      )}

      {st.status === 'applied' && (
        <button
          className="link danger-link"
          disabled={a.busy}
          onClick={() => void a.run(async () => (await api(`/me/applications/${st.reference}/withdraw`, { body: {} }), load()))}
        >
          Withdraw this application
        </button>
      )}
      <ErrorBox error={a.error} />
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="secondary"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)))
          .catch(() => undefined)
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
