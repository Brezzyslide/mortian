import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Page, useAction, useLoad } from '../components/ui';
import { dateTime, naira } from '../format';

interface Pending {
  id: string;
  kind: string;
  finance_account_reference: string;
  payload: Record<string, unknown>;
  reason: string;
  requested_by: string;
  requested_at: string;
}

const KIND: Record<string, string> = {
  terms_out_of_bounds: 'Terms outside tier limits',
  fee_waiver: 'Fee waiver',
  repossession: 'Repossession',
  release: 'Release after repossession',
  close_recovered: 'Close as recovered',
  asset_sale: 'Sell recovered asset',
};

export function Approvals() {
  const { claims } = useAuth();
  const { data, error, reload } = useLoad(() => api<{ pending: Pending[] }>('/admin/lending/approvals'), []);

  return (
    <Page title="Approvals">
      <p className="muted">Each request was made by another staff member. You cannot decide your own.</p>
      <ErrorBox error={error} />
      {data?.pending.length === 0 && <p className="muted">Nothing waiting.</p>}
      {data?.pending.map((p) => (
        <Decision key={p.id} p={p} mine={p.requested_by === claims?.sub} onDone={reload} />
      ))}
    </Page>
  );
}

function Decision({ p, mine, onDone }: { p: Pending; mine: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const action = useAction();
  const decide = (decision: 'approved' | 'rejected') =>
    action.run(() => api(`/admin/lending/approvals/${p.id}/decide`, { body: { decision, note } })).then((ok) => ok && onDone());

  return (
    <div className="panel">
      <div className="page-head">
        <h2 style={{ margin: 0 }}>
          {KIND[p.kind] ?? p.kind} · <Link to={`/accounts/${p.finance_account_reference}`}>{p.finance_account_reference}</Link>
        </h2>
        <span className="muted">{dateTime(p.requested_at)}</span>
      </div>
      <p>
        <strong>Reason:</strong> {p.reason}
      </p>
      {p.kind === 'asset_sale' ? (
        <p>
          <strong>Price:</strong> {naira(String(p.payload['priceKobo']))} · <strong>Buyer:</strong> {String(p.payload['buyerName'])}
          {p.payload['buyerPhone'] ? ` (${String(p.payload['buyerPhone'])})` : ''}
        </p>
      ) : (
        Object.keys(p.payload).length > 0 && <pre>{JSON.stringify(p.payload, null, 2)}</pre>
      )}
      {mine ? (
        <p className="muted">You made this request, so another manager must decide it.</p>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          <label style={{ flex: 1 }}>
            Decision note
            <input value={note} onChange={(e) => setNote(e.target.value)} required minLength={2} />
          </label>
          <button disabled={action.busy || note.length < 2} onClick={() => void decide('approved')}>
            Approve
          </button>
          <button className="secondary" disabled={action.busy || note.length < 2} onClick={() => void decide('rejected')}>
            Reject
          </button>
        </div>
      )}
      <ErrorBox error={action.error} />
    </div>
  );
}
