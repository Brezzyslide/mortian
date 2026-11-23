import { useState } from 'react';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Notice, useAction, useLoad } from '../components/ui';
import { dateTime } from '../format';

interface Guarantor {
  id: string;
  fullName: string;
  phone: string;
  relationship: string;
}

interface Contract {
  id: string;
  status: string;
  documentSha256: string;
  isPlaceholder: boolean;
  issuedAt: string;
  executedAt: string | null;
  certificateSha256: string | null;
  closedReason: string | null;
  documentKey: string | null;
  pdfKey?: string | null;
  signers: { order: number; role: string; name: string; phone: string | null; status: string; signedAt: string | null }[];
  flags: string[];
}

const FLAG: Record<string, string> = {
  flag_same_device_as_borrower: 'A guarantor tried to sign on the borrower’s phone (refused)',
  flag_same_network_as_borrower: 'A guarantor signed from the same network as the borrower: check they are independent',
};

export function GuarantorsPanel({ reference, status }: { reference: string; status: string }) {
  const { can } = useAuth();
  const list = useLoad(() => api<{ guarantors: Guarantor[] }>(`/admin/contracts/accounts/${reference}/guarantors`), [reference]);
  const [form, setForm] = useState({ fullName: '', phone: '', relationship: '' });
  const action = useAction();
  const editable = ['applied', 'approved'].includes(status) && can('underwriter');

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Guarantors</h2>
      {list.data?.guarantors.length === 0 && <p className="muted">None added.</p>}
      {list.data && list.data.guarantors.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Relationship</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.guarantors.map((g) => (
              <tr key={g.id}>
                <td>{g.fullName}</td>
                <td>{g.phone}</td>
                <td>{g.relationship}</td>
                <td>
                  {editable && (
                    <button
                      className="link"
                      onClick={() => void action.run(() => api(`/admin/contracts/guarantors/${g.id}`, { method: 'DELETE' })).then(list.reload)}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <form
          className="row"
          style={{ marginTop: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await action.run(() => api(`/admin/contracts/accounts/${reference}/guarantors`, { body: form }));
            if (ok) (setForm({ fullName: '', phone: '', relationship: '' }), list.reload());
          }}
        >
          <label>
            Full name
            <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required minLength={2} />
          </label>
          <label>
            Phone
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0803 123 4567" required />
          </label>
          <label>
            Relationship
            <input value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} required minLength={2} />
          </label>
          <button disabled={action.busy}>Add guarantor</button>
        </form>
      )}
      <ErrorBox error={action.error ?? list.error} />
    </div>
  );
}

export function ContractsPanel({ reference, status, onChanged }: { reference: string; status: string; onChanged: () => void }) {
  const { can } = useAuth();
  const list = useLoad(() => api<{ contracts: Contract[] }>(`/admin/contracts/accounts/${reference}`), [reference]);
  const action = useAction();
  const [message, setMessage] = useState<string | null>(null);
  const live = list.data?.contracts.find((c) => ['issued', 'partially_signed'].includes(c.status));
  const reload = () => (list.reload(), onChanged());

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Contract</h2>
      {status === 'approved' && !live && can('underwriter') && (
        <button
          disabled={action.busy}
          onClick={() =>
            void action
              .run(async () => {
                await api(`/admin/contracts/accounts/${reference}/issue`, { body: {} });
                setMessage('Issued. The borrower has been sent their signing link by SMS.');
              })
              .then(reload)
          }
        >
          Issue contract for signing
        </button>
      )}
      {list.data?.contracts.length === 0 && status !== 'approved' && <p className="muted">No contract yet. Approve the application first.</p>}
      {list.data?.contracts.map((c) => (
        <ContractCard key={c.id} c={c} onDone={reload} />
      ))}
      {message && <div className="ok">{message}</div>}
      <ErrorBox error={action.error ?? list.error} />
    </div>
  );
}

function ContractCard({ c, onDone }: { c: Contract; onDone: () => void }) {
  const { can } = useAuth();
  const action = useAction();
  const [revoking, setRevoking] = useState('');
  const companyTurn = c.status === 'partially_signed' && c.signers.find((s) => s.role === 'company')?.status === 'open';
  const inFlight = ['issued', 'partially_signed'].includes(c.status);
  const dl = (which: 'agreement' | 'certificate' | 'pdf', ext: string) =>
    void action.run(() => download(`/admin/contracts/${c.id}/archive/${which}`, `${which}-${c.id}.${ext}`));

  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <span className={`badge ${c.status === 'fully_executed' ? 'good' : inFlight ? 'warn' : 'bad'}`}>{c.status.replace('_', ' ')}</span>{' '}
          <span className="muted">issued {dateTime(c.issuedAt)}</span>
        </div>
        <code title={c.documentSha256}>{c.documentSha256.slice(0, 12)}…</code>
      </div>
      {c.isPlaceholder && <Notice>Placeholder wording, not reviewed by a lawyer. Do not use for a real agreement.</Notice>}
      {c.flags.map((f) => (
        <Notice key={f}>{FLAG[f] ?? f}</Notice>
      ))}
      {c.closedReason && <p className="muted">Closed: {c.closedReason}</p>}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Signer</th>
            <th>Phone</th>
            <th>Status</th>
            <th>Signed</th>
          </tr>
        </thead>
        <tbody>
          {c.signers.map((s) => (
            <tr key={s.order}>
              <td>{s.order}</td>
              <td>
                {s.name} <span className="muted">({s.role})</span>
              </td>
              <td>{s.phone ?? '—'}</td>
              <td>
                <span className={`badge ${s.status === 'signed' ? 'good' : s.status === 'open' ? 'warn' : s.status === 'expired' || s.status === 'declined' ? 'bad' : 'neutral'}`}>
                  {s.status === 'open' ? 'waiting for them' : s.status === 'waiting' ? 'not yet' : s.status}
                </span>
              </td>
              <td>{dateTime(s.signedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 10 }}>
        {companyTurn && can('manager') && (
          <button
            disabled={action.busy}
            onClick={() =>
              window.confirm('Countersign for the company? This executes and archives the agreement.') &&
              void action.run(() => api(`/admin/contracts/${c.id}/countersign`, { body: {} })).then((ok) => ok && onDone())
            }
          >
            Countersign for the company
          </button>
        )}
        {inFlight && !companyTurn && can('underwriter', 'manager') && (
          <button className="secondary" disabled={action.busy} onClick={() => void action.run(() => api(`/admin/contracts/${c.id}/resend-link`, { body: {} })).then((ok) => ok && onDone())}>
            Resend link to current signer
          </button>
        )}
        {c.status === 'fully_executed' && (
          <>
            {c.pdfKey && (
              <button className="secondary" onClick={() => dl('pdf', 'pdf')}>
                Signed PDF
              </button>
            )}
            <button className="secondary" onClick={() => dl('agreement', 'txt')}>
              Agreement text
            </button>
            <button className="secondary" onClick={() => dl('certificate', 'json')}>
              Execution certificate
            </button>
          </>
        )}
      </div>
      {inFlight && can('manager') && (
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() => api(`/admin/contracts/${c.id}/revoke`, { body: { reason: revoking } })).then((ok) => ok && onDone());
          }}
        >
          <label style={{ flex: 1 }}>
            Revoke with reason
            <input value={revoking} onChange={(e) => setRevoking(e.target.value)} minLength={5} required />
          </label>
          <button className="danger" disabled={action.busy}>
            Revoke
          </button>
        </form>
      )}
      <ErrorBox error={action.error} />
    </div>
  );
}
