import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Page, Status, useLoad } from '../components/ui';
import { dateTime, STATUS_LABEL } from '../format';

interface Row {
  reference: string;
  productCode: string;
  status: string;
  createdAt: string;
  phone: string | null;
  fullName: string | null;
}

export function Applications() {
  const [status, setStatus] = useState('applied');
  const { data, error, loading } = useLoad(() => api<{ accounts: Row[] }>(`/admin/lending/accounts?status=${status}`), [status]);

  return (
    <Page
      title="Applications"
      actions={
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {['applied', 'approved', 'contracted', 'active', 'settled', 'declined'].map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      }
    >
      <ErrorBox error={error} />
      {loading && !data ? (
        <p className="muted">Loading…</p>
      ) : data?.accounts.length === 0 ? (
        <p className="muted">Nothing here.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Customer</th>
              <th>Product</th>
              <th>Status</th>
              <th>Applied</th>
            </tr>
          </thead>
          <tbody>
            {data?.accounts.map((a) => (
              <tr key={a.reference}>
                <td>
                  <Link to={`/accounts/${a.reference}`}>{a.reference}</Link>
                </td>
                <td>
                  {a.fullName ?? '—'}
                  <div className="muted">{a.phone}</div>
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
    </Page>
  );
}
