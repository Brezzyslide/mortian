import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Notice, Page, useAction, useLoad } from '../components/ui';
import { bps, dateTime, naira, toKobo } from '../format';

interface Rider {
  personId: string;
  reference: string;
  kind: 'financed' | 'own_bike';
  status: 'pending' | 'active' | 'suspended';
  online: boolean;
  fullName: string | null;
  phone: string | null;
  financeReference: string | null;
  licenceAccepted: boolean;
  appliedAt: string;
  lastSeenAt: string | null;
}

const RIDER_TONE = { pending: 'warn', active: 'good', suspended: 'bad' } as const;

export function Riders() {
  const [status, setStatus] = useState('pending');
  const { data, error, reload } = useLoad(() => api<{ riders: Rider[] }>(`/admin/dispatch/riders${status ? `?status=${status}` : ''}`), [status]);
  return (
    <Page
      title="Riders"
      actions={
        <select aria-label="Rider status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Waiting for approval</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="">All</option>
        </select>
      }
    >
      <p className="muted">A rider can be activated once their driver's licence has been accepted on the Documents panel (by an underwriter or manager).</p>
      <ErrorBox error={error} />
      {data?.riders.length === 0 && <p className="muted">No riders here.</p>}
      {data && data.riders.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Rider</th>
              <th>Bike</th>
              <th>Licence</th>
              <th>Status</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.riders.map((r) => (
              <RiderRow key={r.personId} r={r} onDone={reload} />
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

function RiderRow({ r, onDone }: { r: Rider; onDone: () => void }) {
  const [note, setNote] = useState('');
  const action = useAction();
  const decide = (decision: 'active' | 'suspended') =>
    action.run(() => api(`/admin/dispatch/riders/${r.personId}/decision`, { body: { decision, note } })).then((ok) => ok && (setNote(''), onDone()));
  return (
    <tr>
      <td>
        {r.fullName ?? '—'} <span className="muted">{r.reference}</span>
        <div className="muted">{r.phone}</div>
      </td>
      <td>{r.kind === 'financed' ? `Financed (${r.financeReference})` : 'Own bike'}</td>
      <td>{r.licenceAccepted ? <span className="badge good">accepted</span> : <span className="badge warn">not yet</span>}</td>
      <td>
        <span className={`badge ${RIDER_TONE[r.status]}`}>{r.status}</span> {r.online && <span className="badge good">online</span>}
      </td>
      <td>{dateTime(r.lastSeenAt)}</td>
      <td>
        <div className="row">
          <input aria-label={`Note for ${r.reference}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" style={{ width: 140 }} />
          {r.status !== 'active' && (
            <button disabled={action.busy || !r.licenceAccepted || note.trim().length < 3} onClick={() => void decide('active')}>
              Activate
            </button>
          )}
          {r.status !== 'suspended' && (
            <button className="danger" disabled={action.busy || note.trim().length < 3} onClick={() => void decide('suspended')}>
              Suspend
            </button>
          )}
        </div>
        <ErrorBox error={action.error} />
      </td>
    </tr>
  );
}

interface Job {
  reference: string;
  status: string;
  paymentMethod: 'cash' | 'in_app';
  fareKobo: string;
  commissionKobo: string;
  pickupAddress: string;
  dropoffAddress: string;
  createdAt: string;
  customerName: string | null;
  riderReference: string | null;
  riderName: string | null;
  flagged: boolean;
  codeLocked: boolean;
}

const JOB_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  awaiting_payment: 'neutral',
  searching: 'warn',
  accepted: 'warn',
  picked_up: 'warn',
  delivered: 'good',
  cancelled: 'neutral',
};

export function Deliveries() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(() => api<{ jobs: Job[] }>(`/admin/dispatch/jobs${status ? `?status=${status}` : ''}`), [status]);
  return (
    <Page
      title="Deliveries"
      actions={
        <select aria-label="Delivery status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {Object.keys(JOB_TONE).map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
      }
    >
      <ErrorBox error={error} />
      {data && (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Route</th>
              <th>Fare</th>
              <th>Rider</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((j) => (
              <tr key={j.reference}>
                <td>
                  {j.reference}
                  <div className="muted">{dateTime(j.createdAt)} · {j.customerName}</div>
                </td>
                <td>
                  {j.pickupAddress} → {j.dropoffAddress}
                </td>
                <td>
                  {naira(j.fareKobo)} <span className="muted">({j.paymentMethod === 'cash' ? 'cash' : 'in app'}, commission {naira(j.commissionKobo)})</span>
                </td>
                <td>{j.riderName ? `${j.riderName} (${j.riderReference})` : '—'}</td>
                <td>
                  <span className={`badge ${JOB_TONE[j.status] ?? 'neutral'}`}>{j.status.replace('_', ' ')}</span>
                  {j.flagged && <div className="badge bad">delivered far from drop-off</div>}
                  {j.codeLocked && <div className="badge bad">code locked</div>}
                </td>
                <td>
                  <button className="link" onClick={() => setOpen(open === j.reference ? null : j.reference)}>
                    {open === j.reference ? 'Close' : 'History'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.jobs.length === 0 && <p className="muted">No deliveries.</p>}
      {open && <JobHistory reference={open} canCancel={can('dispatch_ops', 'manager')} onDone={() => (setOpen(null), reload())} />}
    </Page>
  );
}

function JobHistory({ reference, canCancel, onDone }: { reference: string; canCancel: boolean; onDone: () => void }) {
  const { data, error } = useLoad(() => api<{ events: { occurredAt: string; kind: string; actorName: string | null; details: Record<string, unknown> }[] }>(`/admin/dispatch/jobs/${reference}/events`), [reference]);
  const [reason, setReason] = useState('');
  const action = useAction();
  const final = data?.events.some((e) => ['delivered', 'cancelled', 'picked_up'].includes(e.kind));
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>{reference}</h2>
      <ErrorBox error={error ?? action.error} />
      <table>
        <tbody>
          {data?.events.map((e, i) => (
            <tr key={i}>
              <td>{dateTime(e.occurredAt)}</td>
              <td>{e.kind.replace('_', ' ')}</td>
              <td>{e.actorName ?? 'System'}</td>
              <td className="muted">
                {typeof e.details['fromDropoffM'] === 'number' && `${e.details['fromDropoffM']} m from drop-off`}
                {typeof e.details['reason'] === 'string' && String(e.details['reason'])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canCancel && data && !final && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() => api(`/admin/dispatch/jobs/${reference}/cancel`, { body: { reason } })).then((ok) => ok && onDone());
          }}
        >
          <label style={{ flex: 1 }}>
            Cancel with reason (a paid fare becomes a refund owed)
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
          </label>
          <button className="danger" disabled={action.busy}>
            Cancel job
          </button>
        </form>
      )}
    </div>
  );
}

interface Pricing {
  baseFareKobo: string;
  perKmKobo: string;
  minFareKobo: string;
  commissionBps: number;
  cashDebtLimitKobo: string;
  searchRadiusM: number;
  isPlaceholder: boolean;
  createdAt: string;
}

export function DispatchPricing() {
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => api<{ pricing: Pricing | null }>('/admin/dispatch/pricing'), []);
  const [f, setF] = useState<Record<string, string> | null>(null);
  const action = useAction();
  const p = data?.pricing;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f!, [k]: e.target.value });
  return (
    <Page title="Delivery pricing">
      <ErrorBox error={error ?? action.error} />
      {data && !p && <p className="muted">No pricing yet. A super admin can load the placeholder prices.</p>}
      {p && (
        <div className="panel">
          {p.isPlaceholder && <Notice>Placeholder prices for testing, not market rates.</Notice>}
          <dl className="facts">
            <dt>Base fare</dt>
            <dd>{naira(p.baseFareKobo)}</dd>
            <dt>Per km</dt>
            <dd>{naira(p.perKmKobo)}</dd>
            <dt>Minimum fare</dt>
            <dd>{naira(p.minFareKobo)}</dd>
            <dt>Commission</dt>
            <dd>{bps(p.commissionBps)} of the fare</dd>
            <dt>Cash debt limit</dt>
            <dd>{naira(p.cashDebtLimitKobo)} (riders owing more get no cash jobs)</dd>
            <dt>Job radius</dt>
            <dd>{(p.searchRadiusM / 1000).toFixed(1)} km from the pickup</dd>
            <dt>Since</dt>
            <dd>{dateTime(p.createdAt)}</dd>
          </dl>
          {can('manager') && !f && (
            <button
              className="secondary"
              onClick={() =>
                setF({
                  base: String(Number(p.baseFareKobo) / 100),
                  perKm: String(Number(p.perKmKobo) / 100),
                  min: String(Number(p.minFareKobo) / 100),
                  commission: String(p.commissionBps / 100),
                  debt: String(Number(p.cashDebtLimitKobo) / 100),
                  radius: String(p.searchRadiusM / 1000),
                })
              }
            >
              Change prices
            </button>
          )}
        </div>
      )}
      {f && (
        <form
          className="grid panel"
          onSubmit={(e) => {
            e.preventDefault();
            void action
              .run(() =>
                api('/admin/dispatch/pricing', {
                  body: {
                    baseFareKobo: toKobo(f['base']!),
                    perKmKobo: toKobo(f['perKm']!),
                    minFareKobo: toKobo(f['min']!),
                    commissionBps: Math.round(Number(f['commission']) * 100),
                    cashDebtLimitKobo: toKobo(f['debt']!),
                    searchRadiusM: Math.round(Number(f['radius']) * 1000),
                  },
                }),
              )
              .then((ok) => ok && (setF(null), reload()));
          }}
        >
          <label>
            Base fare (₦)
            <input value={f['base']} onChange={set('base')} required />
          </label>
          <label>
            Per km (₦)
            <input value={f['perKm']} onChange={set('perKm')} required />
          </label>
          <label>
            Minimum fare (₦)
            <input value={f['min']} onChange={set('min')} required />
          </label>
          <label>
            Commission (%)
            <input value={f['commission']} onChange={set('commission')} required inputMode="decimal" />
          </label>
          <label>
            Cash debt limit (₦)
            <input value={f['debt']} onChange={set('debt')} required />
          </label>
          <label>
            Job radius (km)
            <input value={f['radius']} onChange={set('radius')} required inputMode="decimal" />
          </label>
          <div className="row">
            <button disabled={action.busy}>Save new prices</button>
            <button type="button" className="secondary" onClick={() => setF(null)}>
              Cancel
            </button>
          </div>
          <p className="muted" style={{ gridColumn: '1 / -1' }}>
            New prices apply to new quotes only. Quotes already given keep their price.
          </p>
        </form>
      )}
    </Page>
  );
}
