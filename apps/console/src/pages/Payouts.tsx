import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Notice, Page, useAction, useLoad } from '../components/ui';
import { bps, dateTime, naira, toKobo } from '../format';

interface Payout {
  reference: string;
  kind: 'earnings' | 'loan_repayment';
  trigger: 'weekly' | 'instant';
  grossKobo: string;
  netKobo: string;
  riderFeeKobo: string;
  providerFeeKobo: string;
  status: string;
  failureReason: string | null;
  createdAt: string;
  riderReference: string;
  riderName: string | null;
  destinationBank: string;
  destination: string;
}

interface ReviewItem {
  id: string;
  riderReference: string;
  verifiedName: string | null;
  accountName: string;
  bankName: string;
  accountNumberMasked: string;
  createdAt: string;
}

interface Settings {
  weeklyWeekday: number;
  minPayoutKobo: string;
  instantEnabled: boolean;
  instantFeePaidByRider: boolean;
  instantDailyLimitKobo: string;
  maxLoanShareBps: number;
  coolingOffHours: number;
  isPlaceholder: boolean;
}

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { pending: 'neutral', sent: 'warn', succeeded: 'good', failed: 'bad' };

export function Payouts() {
  const [status, setStatus] = useState('');
  const list = useLoad(() => api<{ payouts: Payout[] }>(`/admin/payouts${status ? `?status=${status}` : ''}`), [status]);
  return (
    <Page
      title="Rider payouts"
      actions={
        <select aria-label="Payout status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="sent">Sent, waiting for the bank</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
        </select>
      }
    >
      <ReviewQueue />
      <SettingsPanel />
      <h2>Payouts</h2>
      <ErrorBox error={list.error} />
      {list.data?.payouts.length === 0 && <p className="muted">No payouts.</p>}
      {list.data && list.data.payouts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Payout</th>
              <th>Rider</th>
              <th>To</th>
              <th>Amount</th>
              <th>Fees</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data.payouts.map((p) => (
              <tr key={p.reference}>
                <td>
                  {p.reference}
                  <div className="muted">
                    {p.trigger} · {p.kind === 'loan_repayment' ? 'to loan' : 'earnings'} · {dateTime(p.createdAt)}
                  </div>
                </td>
                <td>
                  {p.riderName} <span className="muted">{p.riderReference}</span>
                </td>
                <td>
                  {p.destinationBank} {p.destination}
                </td>
                <td>{naira(p.netKobo)}</td>
                <td className="muted">
                  {p.riderFeeKobo !== '0' && `rider paid ${naira(p.riderFeeKobo)}; `}
                  provider {naira(p.providerFeeKobo)}
                </td>
                <td>
                  <span className={`badge ${TONE[p.status] ?? 'neutral'}`}>{p.status}</span>
                  {p.failureReason && <div className="muted">{p.failureReason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

/** Bank accounts whose name does not match the rider's verified name. */
function ReviewQueue() {
  const { data, error, reload } = useLoad(() => api<{ accounts: ReviewItem[] }>('/admin/payouts/bank-accounts/review'), []);
  if (!data || data.accounts.length === 0) return error ? <ErrorBox error={error} /> : null;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Bank accounts to check ({data.accounts.length})</h2>
      <p className="muted">The bank's name for these accounts does not match the rider's verified name. Approve only if the account is the rider's own (for example, a known nickname or a name change with proof).</p>
      {data.accounts.map((a) => (
        <ReviewRow key={a.id} a={a} onDone={reload} />
      ))}
    </div>
  );
}

function ReviewRow({ a, onDone }: { a: ReviewItem; onDone: () => void }) {
  const [note, setNote] = useState('');
  const action = useAction();
  const decide = (decision: 'approved' | 'rejected') =>
    action.run(() => api(`/admin/payouts/bank-accounts/${a.id}/review`, { body: { decision, note } })).then((ok) => ok && onDone());
  return (
    <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div style={{ flex: 1 }}>
        <strong>{a.riderReference}</strong>: verified name <strong>{a.verifiedName ?? '—'}</strong>, bank says <strong>{a.accountName}</strong>
        <div className="muted">
          {a.bankName} {a.accountNumberMasked} · added {dateTime(a.createdAt)}
        </div>
      </div>
      <input aria-label={`Note for ${a.riderReference}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason" />
      <button disabled={action.busy || note.trim().length < 3} onClick={() => void decide('approved')}>
        Approve
      </button>
      <button className="danger" disabled={action.busy || note.trim().length < 3} onClick={() => void decide('rejected')}>
        Reject
      </button>
      <ErrorBox error={action.error} />
    </div>
  );
}

function SettingsPanel() {
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => api<{ settings: Settings | null }>('/admin/payouts/settings'), []);
  const [f, setF] = useState<Record<string, string | boolean> | null>(null);
  const action = useAction();
  const s = data?.settings;
  if (!data) return <ErrorBox error={error} />;
  if (!s) return <p className="muted">Payout rules are not set. A super admin can load the placeholder rules.</p>;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Payout rules</h2>
      {s.isPlaceholder && <Notice>Placeholder rules for testing.</Notice>}
      {!f ? (
        <>
          <dl className="facts">
            <dt>Weekly payout</dt>
            <dd>Every {DAYS[s.weeklyWeekday]}, full balance, fee paid by you</dd>
            <dt>Minimum</dt>
            <dd>{naira(s.minPayoutKobo)}</dd>
            <dt>Instant withdrawal</dt>
            <dd>
              {s.instantEnabled ? `On, up to ${naira(s.instantDailyLimitKobo)} a day; fee paid by ${s.instantFeePaidByRider ? 'the rider' : 'you'}` : 'Off'}
            </dd>
            <dt>Loan share</dt>
            <dd>Riders may send up to {bps(s.maxLoanShareBps)} of each payout to their loan</dd>
            <dt>After an account change</dt>
            <dd>Payouts wait {s.coolingOffHours} hours</dd>
          </dl>
          {can('manager') && (
            <button
              className="secondary"
              onClick={() =>
                setF({
                  day: String(s.weeklyWeekday),
                  min: String(Number(s.minPayoutKobo) / 100),
                  instant: s.instantEnabled,
                  riderPays: s.instantFeePaidByRider,
                  limit: String(Number(s.instantDailyLimitKobo) / 100),
                  share: String(s.maxLoanShareBps / 100),
                  cooling: String(s.coolingOffHours),
                })
              }
            >
              Change rules
            </button>
          )}
        </>
      ) : (
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            void action
              .run(() =>
                api('/admin/payouts/settings', {
                  body: {
                    weeklyWeekday: Number(f['day']),
                    minPayoutKobo: toKobo(String(f['min'])),
                    instantEnabled: !!f['instant'],
                    instantFeePaidByRider: !!f['riderPays'],
                    instantDailyLimitKobo: toKobo(String(f['limit'])),
                    maxLoanShareBps: Math.round(Number(f['share']) * 100),
                    coolingOffHours: Number(f['cooling']),
                  },
                }),
              )
              .then((ok) => ok && (setF(null), reload()));
          }}
        >
          <label>
            Weekly payout day
            <select value={String(f['day'])} onChange={(e) => setF({ ...f, day: e.target.value })}>
              {DAYS.slice(1).map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Minimum payout (₦)
            <input value={String(f['min'])} onChange={(e) => setF({ ...f, min: e.target.value })} required />
          </label>
          <label>
            Instant daily limit (₦)
            <input value={String(f['limit'])} onChange={(e) => setF({ ...f, limit: e.target.value })} required />
          </label>
          <label>
            Maximum loan share (%)
            <input value={String(f['share'])} onChange={(e) => setF({ ...f, share: e.target.value })} required />
          </label>
          <label>
            Cooling-off after account change (hours)
            <input value={String(f['cooling'])} onChange={(e) => setF({ ...f, cooling: e.target.value })} required />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!f['instant']} onChange={(e) => setF({ ...f, instant: e.target.checked })} /> Instant withdrawals on
          </label>
          <label className="check">
            <input type="checkbox" checked={!!f['riderPays']} onChange={(e) => setF({ ...f, riderPays: e.target.checked })} /> Rider pays the instant transfer fee
          </label>
          <div className="row">
            <button disabled={action.busy}>Save rules</button>
            <button type="button" className="secondary" onClick={() => setF(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={action.error} />
    </div>
  );
}
