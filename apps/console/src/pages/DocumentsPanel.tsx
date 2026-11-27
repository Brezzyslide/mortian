import { useEffect, useState } from 'react';
import { api, fetchBlob } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, useAction, useLoad } from '../components/ui';
import { dateTime } from '../format';

interface Doc {
  id: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  status: 'submitted' | 'accepted' | 'rejected' | 'replaced';
  uploadedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

const KIND: Record<string, string> = {
  national_id: 'National ID / NIN slip',
  drivers_licence: "Driver's licence",
  voters_card: "Voter's card",
  passport: 'Passport',
  proof_of_address: 'Proof of address',
  other: 'Other',
};
const TONE = { submitted: 'warn', accepted: 'good', rejected: 'bad', replaced: 'neutral' } as const;
const STATUS = { submitted: 'to review', accepted: 'accepted', rejected: 'rejected', replaced: 'replaced by a newer upload' } as const;

/**
 * A customer's ID documents: view (audited), accept, or reject with a reason they will see.
 * Opened from an application (by reference) or from the customer page (by person id).
 */
export function DocumentsPanel(props: { reference: string } | { personId: string }) {
  const { can } = useAuth();
  const key = 'reference' in props ? props.reference : props.personId;
  const list = useLoad(
    () =>
      'reference' in props
        ? api<{ documents: Doc[] }>(`/admin/lending/accounts/${props.reference}/documents`)
        : api<{ documents: Doc[] | null }>(`/admin/customers/${props.personId}`).then((r) => ({ documents: r.documents ?? [] })),
    [key],
  );
  const [open, setOpen] = useState<string | null>(null);
  if (!can('underwriter', 'manager')) return null;
  // Newest first, replaced uploads last: they are kept for the record only.
  const docs = list.data ? [...(list.data.documents ?? [])].sort((a, b) => Number(a.status === 'replaced') - Number(b.status === 'replaced')) : null;
  const accepted = docs?.some((d) => d.status === 'accepted' && d.kind !== 'proof_of_address');

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Documents</h2>
      {docs && !accepted && 'reference' in props && <p className="muted">No accepted ID yet. Check one before approving.</p>}
      {docs?.length === 0 && <p className="muted">The customer has not uploaded anything. They can do it in the app.</p>}
      {docs && docs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Document</th>
              <th>Uploaded</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className={d.status === 'replaced' ? 'muted' : undefined}>
                <td>
                  {KIND[d.kind] ?? d.kind} <span className="muted">({Math.ceil(d.sizeBytes / 1024)} KB)</span>
                </td>
                <td>{dateTime(d.uploadedAt)}</td>
                <td>
                  <span className={`badge ${TONE[d.status]}`}>{STATUS[d.status]}</span>
                  {d.reviewNote && <div className="muted">{d.reviewNote}</div>}
                </td>
                <td>
                  <button className="link" onClick={() => setOpen(open === d.id ? null : d.id)}>
                    {open === d.id ? 'Close' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && docs && <Viewer doc={docs.find((d) => d.id === open)!} onReviewed={() => (setOpen(null), list.reload())} />}
      <ErrorBox error={list.error} />
    </div>
  );
}

function Viewer({ doc, onReviewed }: { doc: Doc; onReviewed: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const load = useAction();
  const action = useAction();
  useEffect(() => {
    let u: string | null = null;
    void load.run(async () => {
      u = URL.createObjectURL(await fetchBlob(`/admin/documents/${doc.id}/file`));
      setUrl(u);
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);
  const decide = (decision: 'accepted' | 'rejected') =>
    action.run(() => api(`/admin/documents/${doc.id}/review`, { body: { decision, note: note || null } })).then((ok) => ok && onReviewed());

  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted">Opening a document is recorded in the audit log.</p>
      {url && doc.contentType.startsWith('image/') && <img src={url} alt={`${doc.kind} document`} style={{ maxWidth: '100%', maxHeight: 520, border: '1px solid var(--line)' }} />}
      {url && doc.contentType === 'application/pdf' && (
        <a href={url} target="_blank" rel="noreferrer">
          Open the PDF
        </a>
      )}
      {doc.status === 'submitted' && (
        <div className="row" style={{ marginTop: 10 }}>
          <label style={{ flex: 1 }}>
            Note (needed to reject; the customer sees it)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Photo is blurred, retake in daylight" />
          </label>
          <button disabled={action.busy} onClick={() => void decide('accepted')}>
            Accept
          </button>
          <button className="danger" disabled={action.busy || note.trim().length < 5} onClick={() => void decide('rejected')}>
            Reject
          </button>
        </div>
      )}
      <ErrorBox error={load.error ?? action.error} />
    </div>
  );
}
