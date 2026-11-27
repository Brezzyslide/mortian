import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Page, Status, useLoad } from '../components/ui';
import { dateTime } from '../format';
import { DocumentsPanel } from './DocumentsPanel';

interface Row {
  id: string;
  fullName: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
  accounts: number;
  documentsToReview: number;
}

/** Everyone who has signed up, whether or not they have applied. */
export function Customers() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, loading } = useLoad(
    () => api<{ customers: Row[] }>(`/admin/customers${search ? `?q=${encodeURIComponent(search)}` : ''}`),
    [search],
  );
  return (
    <Page title="Customers">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <label style={{ flex: 1 }}>
          Phone, name or account (FA-…)
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="0803 123 4567" />
        </label>
        <button>Search</button>
        {search && (
          <button type="button" className="secondary" onClick={() => (setQ(''), setSearch(''))}>
            Clear
          </button>
        )}
      </form>
      {!search && <p className="muted">Newest sign-ups first (50 at most). Search to find anyone else.</p>}
      <ErrorBox error={error} />
      {loading && !data ? (
        <p className="muted">Loading…</p>
      ) : data?.customers.length === 0 ? (
        <p className="muted">No one matches.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Phone</th>
              <th className="num">Accounts</th>
              <th>Documents</th>
              <th>Signed up</th>
            </tr>
          </thead>
          <tbody>
            {data?.customers.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/customers/${c.id}`}>{c.fullName ?? 'No name yet'}</Link>
                </td>
                <td>{c.phone}</td>
                <td className="num">{c.accounts}</td>
                <td>{c.documentsToReview > 0 ? <span className="badge warn">{c.documentsToReview} to review</span> : <span className="muted">—</span>}</td>
                <td>{dateTime(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

interface Detail {
  customer: { id: string; fullName: string | null; phone: string | null; status: string; createdAt: string; roles: string[] };
  accounts: { reference: string; productCode: string; status: string; createdAt: string }[];
}

export function Customer() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { data, error } = useLoad(() => api<Detail>(`/admin/customers/${id}`), [id]);
  const c = data?.customer;
  return (
    <Page title={c ? (c.fullName ?? 'No name yet') : 'Customer'}>
      <ErrorBox error={error} />
      {c && (
        <>
          <div className="panel">
            <p style={{ margin: 0 }}>
              {c.phone} · signed up {dateTime(c.createdAt)} · {c.roles.join(', ')}
              {c.status !== 'active' && (
                <>
                  {' '}
                  · <strong>{c.status}</strong>
                </>
              )}
            </p>
          </div>
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Accounts</h2>
            {data.accounts.length === 0 ? (
              <p className="muted">No applications yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Product</th>
                    <th>Status</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.reference}>
                      <td>
                        <Link to={`/accounts/${a.reference}`}>{a.reference}</Link>
                      </td>
                      <td>{a.productCode.replace(/_/g, ' ')}</td>
                      <td>
                        <Status value={a.status} />
                      </td>
                      <td>{dateTime(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {can('underwriter', 'manager') && <DocumentsPanel personId={c.id} />}
        </>
      )}
    </Page>
  );
}
