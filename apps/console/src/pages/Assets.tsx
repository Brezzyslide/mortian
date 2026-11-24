import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Page, useAction, useLoad } from '../components/ui';
import { dateTime, naira, toKobo } from '../format';

export interface Asset {
  id: string;
  kind: string;
  make: string;
  model: string;
  year: number | null;
  idKind: string;
  identifier: string;
  engineNumber: string | null;
  plateNumber: string | null;
  costKobo: string;
  status: string;
  location: string;
  reference: string | null;
  createdAt: string;
}

export const ASSET_STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  in_stock: { label: 'In stock', tone: 'neutral' },
  assigned: { label: 'Reserved for handover', tone: 'warn' },
  with_customer: { label: 'With customer', tone: 'good' },
  recovered: { label: 'Recovered (in yard)', tone: 'bad' },
  for_sale: { label: 'For sale', tone: 'warn' },
  sold: { label: 'Sold', tone: 'neutral' },
  paid_off: { label: 'Paid off, papers due', tone: 'good' },
  title_transferred: { label: 'Owned by customer', tone: 'good' },
  written_off: { label: 'Written off', tone: 'neutral' },
};
const ID_LABEL: Record<string, string> = { chassis: 'Chassis', imei: 'IMEI', serial: 'Serial' };

export function AssetBadge({ status }: { status: string }) {
  const s = ASSET_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export const describe = (a: Asset) => `${a.make} ${a.model}${a.year ? ` (${a.year})` : ''}`;

export function Assets() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useLoad(
    () => api<{ assets: Asset[] }>(`/admin/assets?${new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}) })}`),
    [status, search],
  );

  return (
    <Page
      title="Assets"
      actions={
        can('dispatch_ops', 'manager') && !adding ? (
          <button onClick={() => setAdding(true)}>Register an asset</button>
        ) : undefined
      }
    >
      {adding && <RegisterForm onDone={() => (setAdding(false), list.reload())} onCancel={() => setAdding(false)} />}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <label style={{ flex: 1 }}>
          Find by chassis, IMEI, serial, plate or account
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. 7LC000111, KUJ123AB, FA-000012" />
        </label>
        <label>
          Status
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(ASSET_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary">Search</button>
      </form>
      <ErrorBox error={list.error} />
      {list.data && (
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Identifier</th>
              <th>Plate</th>
              <th>Status</th>
              <th>Where</th>
              <th>Account</th>
            </tr>
          </thead>
          <tbody>
            {list.data.assets.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link to={`/assets/${a.id}`}>{describe(a)}</Link>
                </td>
                <td>
                  <code>{a.identifier}</code>
                </td>
                <td>{a.plateNumber ?? '—'}</td>
                <td>
                  <AssetBadge status={a.status} />
                </td>
                <td>{a.location}</td>
                <td>{a.reference ? <Link to={`/accounts/${a.reference}`}>{a.reference}</Link> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list.data?.assets.length === 0 && <p className="muted">No assets match.</p>}
    </Page>
  );
}

function RegisterForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ kind: 'motorcycle', make: '', model: '', year: '', identifier: '', engineNumber: '', plateNumber: '', cost: '', location: '' });
  const action = useAction();
  const idKind = f.kind === 'motorcycle' ? 'chassis' : f.kind === 'phone' ? 'imei' : 'serial';
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action
      .run(() =>
        api('/admin/assets', {
          body: {
            kind: f.kind,
            make: f.make,
            model: f.model,
            year: f.year ? Number(f.year) : null,
            idKind,
            identifier: f.identifier,
            engineNumber: f.engineNumber || null,
            plateNumber: f.plateNumber || null,
            costKobo: toKobo(f.cost),
            location: f.location,
          },
        }),
      )
      .then((ok) => ok && onDone());
  };
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Register an asset</h2>
      <form className="grid" onSubmit={submit}>
        <label>
          Kind
          <select value={f.kind} onChange={set('kind')}>
            <option value="motorcycle">Motorcycle</option>
            <option value="phone">Phone</option>
            <option value="equipment">Equipment</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          Make
          <input value={f.make} onChange={set('make')} required placeholder="Bajaj" />
        </label>
        <label>
          Model
          <input value={f.model} onChange={set('model')} required placeholder="Boxer BM150" />
        </label>
        <label>
          Year
          <input value={f.year} onChange={set('year')} inputMode="numeric" placeholder="2026" />
        </label>
        <label>
          {ID_LABEL[idKind]} number
          <input value={f.identifier} onChange={set('identifier')} required />
        </label>
        {f.kind === 'motorcycle' && (
          <>
            <label>
              Engine number
              <input value={f.engineNumber} onChange={set('engineNumber')} />
            </label>
            <label>
              Plate
              <input value={f.plateNumber} onChange={set('plateNumber')} />
            </label>
          </>
        )}
        <label>
          Cost to us (₦)
          <input value={f.cost} onChange={set('cost')} required inputMode="decimal" placeholder="1,200,000" />
        </label>
        <label>
          Location
          <input value={f.location} onChange={set('location')} required placeholder="Mararaba yard" />
        </label>
        <div className="row">
          <button disabled={action.busy}>Register</button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
      <p className="muted">The identifier, kind and cost cannot be changed later. If you make a mistake, write the asset off and register it again.</p>
      <ErrorBox error={action.error} />
    </div>
  );
}

interface AssetEvent {
  occurredAt: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string;
  location: string | null;
  reference: string | null;
  note: string | null;
  details: Record<string, unknown>;
  actorName: string | null;
}

const EVENT: Record<string, string> = {
  registered: 'Registered',
  assigned: 'Reserved for account',
  unassigned: 'Returned to stock',
  handed_over: 'Handed over to customer',
  moved: 'Moved',
  recovered: 'Repossessed',
  returned: 'Returned to customer',
  listed_for_sale: 'Listed for sale',
  sold: 'Sold',
  paid_off: 'Paid off',
  title_transferred: 'Papers handed over',
  written_off: 'Written off',
};

export function AssetDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => api<{ asset: Asset; events: AssetEvent[] }>(`/admin/assets/${id}`), [id]);
  const action = useAction();
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  if (!data) return <Page title="Asset">{<ErrorBox error={error} />}</Page>;
  const a = data.asset;
  const post = (path: string, body: unknown) => action.run(() => api(`/admin/assets/${a.id}/${path}`, { body })).then((ok) => ok && (setNote(''), setLocation(''), reload()));
  const final = ['sold', 'written_off', 'title_transferred'].includes(a.status);

  return (
    <Page title={describe(a)} actions={<AssetBadge status={a.status} />}>
      <div className="panel">
        <dl className="facts">
          <dt>{ID_LABEL[a.idKind]}</dt>
          <dd>
            <code>{a.identifier}</code>
          </dd>
          {a.engineNumber && (
            <>
              <dt>Engine</dt>
              <dd>{a.engineNumber}</dd>
            </>
          )}
          <dt>Plate</dt>
          <dd>{a.plateNumber ?? '—'}</dd>
          <dt>Cost</dt>
          <dd>{naira(a.costKobo)}</dd>
          <dt>Where</dt>
          <dd>{a.location}</dd>
          <dt>Account</dt>
          <dd>{a.reference ? <Link to={`/accounts/${a.reference}`}>{a.reference}</Link> : '—'}</dd>
        </dl>
      </div>

      {!final && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Actions</h2>
          {can('dispatch_ops', 'collections', 'manager') && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void post('move', { location, ...(note ? { note } : {}) });
              }}
            >
              <label style={{ flex: 1 }}>
                Now at
                <input value={location} onChange={(e) => setLocation(e.target.value)} required minLength={2} />
              </label>
              <button className="secondary" disabled={action.busy}>
                Record location
              </button>
            </form>
          )}
          <label>
            Note (needed for the actions below)
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row">
            {a.status === 'assigned' && can('underwriter', 'dispatch_ops', 'manager') && (
              <button className="secondary" disabled={action.busy || note.length < 5} onClick={() => void post('unassign', { note })}>
                Return to stock
              </button>
            )}
            {a.status === 'paid_off' && can('manager') && (
              <button disabled={action.busy || note.length < 5} onClick={() => void post('title-transferred', { note })}>
                Papers handed to customer
              </button>
            )}
            {['in_stock', 'recovered', 'for_sale'].includes(a.status) && can('manager') && (
              <button
                className="danger"
                disabled={action.busy || note.length < 5}
                onClick={() => window.confirm('Write this asset off? This cannot be undone.') && void post('write-off', { note })}
              >
                Write off
              </button>
            )}
          </div>
          {a.status === 'for_sale' && a.reference && (
            <p className="muted">
              To sell it, open <Link to={`/accounts/${a.reference}`}>{a.reference}</Link> and request the sale. A second manager approves it.
            </p>
          )}
          <ErrorBox error={action.error} />
        </div>
      )}

      <h2>History</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Where</th>
            <th>Account</th>
            <th>By</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {data.events.map((e, i) => (
            <tr key={i}>
              <td>{dateTime(e.occurredAt)}</td>
              <td>
                {EVENT[e.kind] ?? e.kind}
                {e.kind === 'sold' && typeof e.details['priceKobo'] === 'string' && ` for ${naira(e.details['priceKobo'] as string)} to ${String(e.details['buyerName'] ?? '')}`}
              </td>
              <td>{e.location ?? '—'}</td>
              <td>{e.reference ?? '—'}</td>
              <td>{e.actorName ?? 'System'}</td>
              <td>{e.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

/** On the account page: which unit is financed, assigning one, and requesting a resale. */
export function AssetPanel({ reference, status, onChanged }: { reference: string; status: string; onChanged: () => void }) {
  const { can } = useAuth();
  const current = useLoad(() => api<{ asset: Asset | null }>(`/admin/lending/accounts/${reference}/asset`), [reference]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Asset[] | null>(null);
  const [sale, setSale] = useState({ price: '', buyerName: '', buyerPhone: '', reason: '' });
  const [message, setMessage] = useState<string | null>(null);
  const action = useAction();
  const a = current.data?.asset;
  const canAssign = !a && ['approved', 'contracted'].includes(status) && can('underwriter', 'dispatch_ops', 'manager');

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Asset</h2>
      {a ? (
        <p>
          <Link to={`/assets/${a.id}`}>{describe(a)}</Link> · <code>{a.identifier}</code>
          {a.plateNumber && ` · ${a.plateNumber}`} · <AssetBadge status={a.status} /> · {a.location}
        </p>
      ) : (
        <p className="muted">{status === 'applied' ? 'Assign a unit after approval.' : 'No asset assigned. Handover needs one.'}</p>
      )}

      {canAssign && (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => setFound((await api<{ assets: Asset[] }>(`/admin/assets?${new URLSearchParams({ status: 'in_stock', q })}`)).assets));
            }}
          >
            <label style={{ flex: 1 }}>
              Find a unit in stock
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="chassis, IMEI or plate" />
            </label>
            <button className="secondary" disabled={action.busy}>
              Search stock
            </button>
          </form>
          {found?.length === 0 && <p className="muted">Nothing in stock matches.</p>}
          {found?.map((f) => (
            <div key={f.id} className="row">
              <span>
                {describe(f)} · <code>{f.identifier}</code> · {f.location}
              </span>
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(() => api(`/admin/assets/${f.id}/assign`, { body: { reference } })).then((ok) => ok && (setFound(null), current.reload(), onChanged()))
                }
              >
                Assign
              </button>
            </div>
          ))}
        </>
      )}

      {a?.status === 'for_sale' && status === 'closed_recovered' && can('collections', 'manager') && (
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api(`/admin/lending/accounts/${reference}/asset-sale-requests`, {
                body: { priceKobo: toKobo(sale.price), buyerName: sale.buyerName, buyerPhone: sale.buyerPhone || null, reason: sale.reason },
              });
              setMessage('Sale requested. Another manager approves it under Approvals.');
            });
          }}
        >
          <label>
            Sale price (₦)
            <input value={sale.price} onChange={(e) => setSale({ ...sale, price: e.target.value })} required inputMode="decimal" />
          </label>
          <label>
            Buyer name
            <input value={sale.buyerName} onChange={(e) => setSale({ ...sale, buyerName: e.target.value })} required minLength={3} />
          </label>
          <label>
            Buyer phone
            <input value={sale.buyerPhone} onChange={(e) => setSale({ ...sale, buyerPhone: e.target.value })} />
          </label>
          <label>
            Why this price (offers received, condition)
            <input value={sale.reason} onChange={(e) => setSale({ ...sale, reason: e.target.value })} required minLength={5} />
          </label>
          <button disabled={action.busy}>Request sale</button>
          <p className="muted" style={{ gridColumn: '1 / -1' }}>
            On approval the price pays down what the borrower owes (fees, penalty, interest, then principal). Anything above that is recorded as owed back to them.
          </p>
        </form>
      )}
      {message && <div className="ok">{message}</div>}
      <ErrorBox error={action.error ?? current.error} />
    </div>
  );
}
