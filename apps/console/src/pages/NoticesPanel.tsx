import { api } from '../api';
import { ErrorBox, useLoad } from '../components/ui';
import { dateTime } from '../format';

interface Notice {
  sentAt: string;
  template: string;
  recipientRole: 'borrower' | 'guarantor';
  recipientName: string | null;
  providerMessageId: string | null;
}

const WHAT: Record<string, string> = {
  arrears_notice: 'Missed payment',
  arrears_repossession_review: 'Under review: amount and deadline',
  arrears_cured: 'Back up to date',
  guarantor_arrears_review: 'Guarantor told: under review, amount and deadline',
  guarantor_arrears_cured: 'Guarantor told: back up to date',
};

/** What the borrower and guarantors have been told by SMS about this account. */
export function NoticesPanel({ reference }: { reference: string }) {
  const { data, error } = useLoad(() => api<{ notices: Notice[] }>(`/admin/lending/accounts/${reference}/notices`), [reference]);
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Messages sent</h2>
      {data?.notices.length === 0 && <p className="muted">No arrears messages sent.</p>}
      {data && data.notices.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>To</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {data.notices.map((n, i) => (
              <tr key={i}>
                <td>{dateTime(n.sentAt)}</td>
                <td>
                  {n.recipientName ?? '—'} <span className="muted">({n.recipientRole})</span>
                </td>
                <td>
                  {WHAT[n.template] ?? n.template}
                  {!n.providerMessageId && <span className="muted"> · not confirmed by the SMS provider</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
