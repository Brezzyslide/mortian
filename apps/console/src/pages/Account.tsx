import { useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Notice, Page, Status, useAction, useLoad } from '../components/ui';
import { bps, dateTime, naira, toKobo } from '../format';

export interface Statement {
  reference: string;
  productCode: string;
  customer: { phone: string | null; fullName: string | null };
  status: string;
  tier: string | null;
  isPlaceholderTerms: boolean;
  asOf: string;
  outstanding: { principal: string; interest: string; fees: string; penalty: string; total: string };
  credit: string;
  missed: { instalments: number; amount: string; oldestDueDate: string | null; daysOverdue: number };
  next: { dueDate: string; amount: string } | null;
  paidOffPercent: number;
  schedule: { seq: number; dueDate: string; principal: string; interest: string; paid: string; state: string }[];
  arrears: {
    reactivationAmount: string;
    penaltyOutstanding: string;
    feesOutstanding: string;
    reviewStartsOn: string | null;
    reviewStartedOn: string | null;
    cureDeadline: string | null;
    cureDeadlinePassed: boolean;
    repossessedOn: string | null;
    steps: { code: string; text: string }[];
  } | null;
}

interface Fee {
  id: string;
  code: string;
  amount: string;
  paid: string;
  status: string;
  chargedAt: string;
}

export function Account() {
  const { reference = '' } = useParams();
  const { can } = useAuth();
  const s = useLoad(() => api<Statement>(`/admin/lending/accounts/${reference}`), [reference]);
  const fees = useLoad(() => api<{ fees: Fee[] }>(`/admin/lending/accounts/${reference}/fees`), [reference]);
  const reload = () => (s.reload(), fees.reload());
  const st = s.data;

  return (
    <Page title={reference} actions={st && <Status value={st.status} />}>
      <ErrorBox error={s.error} />
      {st && (
        <>
          <p className="muted">
            {st.customer.fullName ?? 'Customer'} · {st.customer.phone} · {st.productCode.replace(/_/g, ' ')}
            {st.tier && ` · tier ${st.tier}`}
          </p>
          {st.isPlaceholderTerms && <Notice>Approved on placeholder tier terms. Replace tiers with real pricing before launch.</Notice>}

          <div className="grid">
            <Stat k="Total outstanding" v={naira(st.outstanding.total)} />
            <Stat k="Principal" v={naira(st.outstanding.principal)} />
            <Stat k="Interest due" v={naira(st.outstanding.interest)} />
            <Stat k="Penalty" v={naira(st.outstanding.penalty)} />
            <Stat k="Fees" v={naira(st.outstanding.fees)} />
            <Stat k="Credit held" v={naira(st.credit)} />
            <Stat k="Paid off" v={`${st.paidOffPercent}%`} />
            <Stat k="Next due" v={st.next ? `${naira(st.next.amount)} on ${st.next.dueDate}` : '—'} />
          </div>

          {(st.missed.instalments > 0 || st.arrears) && (
            <div className="panel">
              <h2>Arrears</h2>
              <div className="grid">
                <Stat k="Missed instalments" v={String(st.missed.instalments)} />
                <Stat k="Amount missed" v={naira(st.missed.amount)} />
                <Stat k="Days overdue" v={String(st.missed.daysOverdue)} />
                {st.arrears && <Stat k="Reactivation amount" v={naira(st.arrears.reactivationAmount)} />}
                {st.arrears?.reviewStartsOn && <Stat k="Review starts" v={st.arrears.reviewStartsOn} />}
                {st.arrears?.cureDeadline && (
                  <Stat k="Cure deadline" v={`${st.arrears.cureDeadline}${st.arrears.cureDeadlinePassed ? ' (passed)' : ''}`} />
                )}
              </div>
              {st.arrears && st.arrears.steps.length > 0 && (
                <>
                  <h2>What the borrower is told</h2>
                  <ul>
                    {st.arrears.steps.map((x) => (
                      <li key={x.code}>{x.text}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {st.status === 'applied' && can('underwriter') && <ApproveForm st={st} onDone={reload} />}
          {['approved', 'contracted'].includes(st.status) && can('manager') && <ActivateForm st={st} onDone={reload} />}
          {st.status === 'repossession_review' && can('collections') && <RepossessionForm st={st} onDone={reload} />}
          {st.status === 'repossessed' && can('collections') && <RequestForm st={st} kind="release" onDone={reload} />}
          {['repossession_review', 'repossessed'].includes(st.status) && st.arrears?.cureDeadlinePassed && can('collections', 'manager') && (
            <RequestForm st={st} kind="close" onDone={reload} />
          )}

          <h2>Fees</h2>
          <FeesPanel reference={reference} fees={fees.data?.fees ?? []} onDone={reload} />

          {st.schedule.length > 0 && (
            <>
              <h2>Schedule</h2>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Due</th>
                    <th className="num">Principal</th>
                    <th className="num">Interest</th>
                    <th className="num">Paid</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {st.schedule.map((i) => (
                    <tr key={i.seq}>
                      <td>{i.seq}</td>
                      <td>{i.dueDate}</td>
                      <td className="num">{naira(i.principal)}</td>
                      <td className="num">{naira(i.interest)}</td>
                      <td className="num">{naira(i.paid)}</td>
                      <td>
                        <span className={`badge ${i.state === 'missed' ? 'bad' : i.state === 'paid' ? 'good' : 'neutral'}`}>
                          {i.state.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </Page>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

// ---------------- Approve on a tier ----------------

interface Bound {
  default: number;
  min: number;
  max: number;
}
interface Tier {
  tier: string;
  version: number;
  is_placeholder: boolean;
  config: {
    frequency: string;
    interestMethod: string;
    assetPriceKobo: { min: string; max: string };
    bounds: Record<string, Bound>;
  };
}

const TERM_LABELS: Record<string, [string, 'bps' | 'int']> = {
  depositBps: ['Deposit', 'bps'],
  tenorPeriods: ['Instalments', 'int'],
  annualInterestBps: ['Interest (per year)', 'bps'],
  penaltyBpsPerDay: ['Penalty per day', 'bps'],
  graceDays: ['Grace days', 'int'],
  repossessionReviewDaysOverdue: ['Review after (days overdue)', 'int'],
  reactivationWindowDays: ['Reactivation window (days)', 'int'],
  guarantorsRequired: ['Guarantors', 'int'],
  guarantorMaxLiabilityBps: ['Guarantor max liability', 'bps'],
};

function ApproveForm({ st, onDone }: { st: Statement; onDone: () => void }) {
  const tiers = useLoad(() => api<{ tiers: Tier[] }>(`/admin/lending/tiers/${st.productCode}`), [st.productCode]);
  const [tierCode, setTierCode] = useState('');
  const [price, setPrice] = useState('');
  const [adj, setAdj] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const action = useAction();
  const tier = tiers.data?.tiers.find((t) => t.tier === tierCode);

  const outOfBounds = useMemo(() => {
    if (!tier) return [];
    return Object.entries(adj)
      .filter(([, v]) => v !== '')
      .filter(([k, v]) => {
        const b = tier.config.bounds[k]!;
        return Number(v) < b.min || Number(v) > b.max;
      })
      .map(([k]) => TERM_LABELS[k]?.[0] ?? k);
  }, [adj, tier]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const adjustments = Object.fromEntries(
        Object.entries(adj)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => [k, Number(v)]),
      );
      const r = await api<{ status: string; requestId?: string }>(`/admin/lending/accounts/${st.reference}/approve`, {
        body: {
          tier: tierCode,
          assetPriceKobo: toKobo(price),
          ...(Object.keys(adjustments).length ? { adjustments } : {}),
          ...(reason ? { reason } : {}),
        },
      });
      setResult(
        r.status === 'approved'
          ? 'Approved. Terms are frozen for this account.'
          : 'Outside tier bounds: sent to a manager for second approval.',
      );
      onDone();
    });
  }

  return (
    <div className="panel">
      <h2>Approve on a tier</h2>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <label>
            Tier
            <select value={tierCode} onChange={(e) => (setTierCode(e.target.value), setAdj({}))} required>
              <option value="">Choose…</option>
              {tiers.data?.tiers.map((t) => (
                <option key={t.tier} value={t.tier}>
                  {t.tier} (v{t.version}
                  {t.is_placeholder ? ', placeholder' : ''})
                </option>
              ))}
            </select>
          </label>
          <label>
            Asset price (₦)
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1,500,000" required />
          </label>
        </div>
        {tier && (
          <>
            <p className="muted">
              {tier.config.frequency} instalments, {tier.config.interestMethod} interest. Price range {naira(tier.config.assetPriceKobo.min)} –{' '}
              {naira(tier.config.assetPriceKobo.max)}. Leave a term blank to use the tier default.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Term</th>
                  <th className="num">Default</th>
                  <th className="num">Allowed</th>
                  <th>Adjust</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(tier.config.bounds).map(([k, b]) => {
                  const [label, unit] = TERM_LABELS[k] ?? [k, 'int'];
                  const show = (n: number) => (unit === 'bps' ? bps(n) : String(n));
                  return (
                    <tr key={k}>
                      <td>{label}</td>
                      <td className="num">{show(b.default)}</td>
                      <td className="num">
                        {show(b.min)} – {show(b.max)}
                      </td>
                      <td>
                        <input
                          aria-label={label}
                          inputMode="numeric"
                          value={adj[k] ?? ''}
                          placeholder={unit === 'bps' ? 'basis points' : ''}
                          onChange={(e) => setAdj({ ...adj, [k]: e.target.value.replace(/\D/g, '') })}
                          style={{ width: 110 }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {outOfBounds.length > 0 && (
              <>
                <Notice>Outside this tier's limits: {outOfBounds.join(', ')}. A manager must confirm, so give a reason.</Notice>
                <label>
                  Reason
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
                </label>
              </>
            )}
          </>
        )}
        <button disabled={action.busy || !tier}>{outOfBounds.length ? 'Send for second approval' : 'Approve'}</button>
      </form>
      {result && <div className="ok">{result}</div>}
      <ErrorBox error={action.error ?? tiers.error} />
    </div>
  );
}

// ---------------- Activate ----------------

function ActivateForm({ st, onDone }: { st: Statement; onDone: () => void }) {
  const [startDate, setStartDate] = useState('');
  const action = useAction();
  return (
    <div className="panel">
      <h2>Hand over and activate</h2>
      <p className="muted">
        Needs the deposit in credit (now {naira(st.credit)}). Generates the repayment schedule from the frozen terms.
      </p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await action.run(() => api(`/admin/lending/accounts/${st.reference}/activate`, { body: startDate ? { startDate } : {} }))) onDone();
        }}
      >
        <label>
          Start date (optional)
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <button disabled={action.busy}>Activate</button>
      </form>
      <ErrorBox error={action.error} />
    </div>
  );
}

// ---------------- Recovery requests (second person confirms in Approvals) ----------------

function RepossessionForm({ st, onDone }: { st: Statement; onDone: () => void }) {
  const [f, setF] = useState({ reason: '', location: '', condition: '', photoRefs: '' });
  const [sent, setSent] = useState(false);
  const action = useAction();
  return (
    <div className="panel">
      <h2>Request repossession</h2>
      <p className="muted">A manager must confirm from their own login.</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await action.run(() =>
            api(`/admin/lending/accounts/${st.reference}/repossession-requests`, {
              body: { ...f, photoRefs: f.photoRefs.split(/\s+/).filter(Boolean) },
            }),
          );
          if (ok) (setSent(true), onDone());
        }}
      >
        <label>
          Reason
          <textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} />
        </label>
        <div className="row">
          <label>
            Location
            <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} required />
          </label>
          <label>
            Asset condition
            <input value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })} required />
          </label>
        </div>
        <label>
          Photo references (space separated)
          <input value={f.photoRefs} onChange={(e) => setF({ ...f, photoRefs: e.target.value })} />
        </label>
        <button className="danger" disabled={action.busy || sent}>
          Send for manager approval
        </button>
      </form>
      {sent && <div className="ok">Sent. It appears in the manager's Approvals.</div>}
      <ErrorBox error={action.error} />
    </div>
  );
}

function RequestForm({ st, kind, onDone }: { st: Statement; kind: 'release' | 'close'; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);
  const action = useAction();
  const title = kind === 'release' ? 'Request release (reactivation)' : 'Request closure as recovered';
  const hint =
    kind === 'release'
      ? `Allowed only once the reactivation amount (${naira(st.arrears?.reactivationAmount)}) is fully paid.`
      : 'The cure deadline has passed. A manager must confirm.';
  return (
    <div className="panel">
      <h2>{title}</h2>
      <p className="muted">{hint}</p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const path = kind === 'release' ? 'release-requests' : 'close-requests';
          if (await action.run(() => api(`/admin/lending/accounts/${st.reference}/${path}`, { body: { reason } }))) {
            setSent(true);
            onDone();
          }
        }}
      >
        <label style={{ flex: 1 }}>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
        </label>
        <button disabled={action.busy || sent}>Send for manager approval</button>
      </form>
      {sent && <div className="ok">Sent. It appears in the manager's Approvals.</div>}
      <ErrorBox error={action.error} />
    </div>
  );
}

// ---------------- Fees ----------------

function FeesPanel({ reference, fees, onDone }: { reference: string; fees: Fee[]; onDone: () => void }) {
  const { can } = useAuth();
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [waive, setWaive] = useState<{ id: string; reason: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const action = useAction();

  return (
    <div className="panel">
      {fees.length === 0 ? (
        <p className="muted">No fees charged.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Fee</th>
              <th>Charged</th>
              <th className="num">Amount</th>
              <th className="num">Paid</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {fees.map((f) => (
              <tr key={f.id}>
                <td>{f.code}</td>
                <td>{dateTime(f.chargedAt)}</td>
                <td className="num">{naira(f.amount)}</td>
                <td className="num">{naira(f.paid)}</td>
                <td>{f.status}</td>
                <td>
                  {f.status === 'open' && BigInt(f.paid) < BigInt(f.amount) && can('collections', 'finance') && (
                    <button className="link" onClick={() => setWaive({ id: f.id, reason: '' })}>
                      Request waiver
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {waive && (
        <form
          className="row"
          style={{ marginTop: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await action.run(() => api(`/admin/lending/fees/${waive.id}/waiver-requests`, { body: { reason: waive.reason } }));
            if (ok) (setWaive(null), setMessage('Waiver request sent to a manager.'), onDone());
          }}
        >
          <label style={{ flex: 1 }}>
            Waiver reason
            <input value={waive.reason} onChange={(e) => setWaive({ ...waive, reason: e.target.value })} required minLength={5} />
          </label>
          <button disabled={action.busy}>Send</button>
          <button type="button" className="secondary" onClick={() => setWaive(null)}>
            Cancel
          </button>
        </form>
      )}

      {can('finance', 'manager') && (
        <form
          className="row"
          style={{ marginTop: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await action.run(() =>
              api(`/admin/lending/accounts/${reference}/fees`, { body: { code, amountKobo: toKobo(amount) } }),
            );
            if (ok) (setCode(''), setAmount(''), setMessage('Fee charged.'), onDone());
          }}
        >
          <label>
            Fee code
            <input value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} placeholder="recovery_cost" required />
          </label>
          <label>
            Amount (₦)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          <button disabled={action.busy}>Charge fee</button>
        </form>
      )}
      {message && <div className="ok">{message}</div>}
      <ErrorBox error={action.error} />
    </div>
  );
}
