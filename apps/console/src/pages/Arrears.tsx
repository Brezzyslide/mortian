import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Page, Status, useLoad } from '../components/ui';
import { naira } from '../format';

interface Item {
  reference: string;
  status: string;
  phone: string | null;
  daysOverdue: number;
  missedInstalments: number;
  missedAmount: string;
  reactivationAmount: string;
  cureDeadline: string | null;
  cureDeadlinePassed: boolean;
}

export function Arrears() {
  const [status, setStatus] = useState('');
  const { data, error } = useLoad(() => api<{ items: Item[] }>(`/admin/lending/arrears${status ? `?status=${status}` : ''}`), [status]);

  return (
    <Page
      title="Arrears"
      actions={
        <select aria-label="Filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All overdue</option>
          <option value="in_arrears">In arrears</option>
          <option value="repossession_review">Repossession review</option>
          <option value="repossessed">Repossessed</option>
        </select>
      }
    >
      <ErrorBox error={error} />
      {data?.items.length === 0 ? (
        <p className="muted">No accounts overdue.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Status</th>
              <th className="num">Days overdue</th>
              <th className="num">Missed</th>
              <th className="num">Amount missed</th>
              <th className="num">To reactivate</th>
              <th>Cure deadline</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((i) => (
              <tr key={i.reference}>
                <td>
                  <Link to={`/accounts/${i.reference}`}>{i.reference}</Link>
                </td>
                <td>
                  <Status value={i.status} />
                </td>
                <td className="num">{i.daysOverdue}</td>
                <td className="num">{i.missedInstalments}</td>
                <td className="num">{naira(i.missedAmount)}</td>
                <td className="num">{naira(i.reactivationAmount)}</td>
                <td>
                  {i.cureDeadline ?? '—'}
                  {i.cureDeadlinePassed && <span className="badge bad"> passed</span>}
                </td>
                <td>{i.phone ? <a href={`tel:${i.phone}`}>{i.phone}</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
