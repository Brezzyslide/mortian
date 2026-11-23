import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Notice, Page, useAction, useLoad } from '../components/ui';
import { dateTime } from '../format';

interface Template {
  id: string;
  version: number;
  title: string;
  body: string;
  isPlaceholder: boolean;
  status: string;
  createdBy: string | null;
  createdAt: string;
  approvedAt: string | null;
  legalReviewNote: string | null;
}

const PRODUCTS = ['motorcycle_ride_to_own', 'phone_financing', 'school_fee_financing', 'business_equipment_finance', 'purchase_and_deliver'];

export function Templates() {
  const { can, claims } = useAuth();
  const [product, setProduct] = useState(PRODUCTS[0]!);
  const { data, error, reload } = useLoad(() => api<{ templates: Template[] }>(`/admin/contracts/templates/${product}`), [product]);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const action = useAction();
  const current = data?.templates.find((t) => t.status === 'approved');

  return (
    <Page
      title="Contract templates"
      actions={
        <select aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)}>
          {PRODUCTS.map((p) => (
            <option key={p} value={p}>
              {p.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      }
    >
      <p className="muted">
        Contracts are issued from the newest approved version. A different manager must approve each version, recording the legal review.
        Approved wording can never be edited.
      </p>
      <ErrorBox error={error ?? action.error} />
      {data?.templates.length === 0 && (
        <p className="muted">
          No template for this product.{' '}
          {product === 'motorcycle_ride_to_own' && can('super_admin') && (
            <button className="link" onClick={() => void action.run(() => api('/admin/contracts/seed-placeholder-template', { body: {} })).then(reload)}>
              Load the placeholder template
            </button>
          )}
        </p>
      )}
      {can('manager') && !draft && (
        <button className="secondary" style={{ marginBottom: 12 }} onClick={() => setDraft({ title: current?.title ?? '', body: current?.body ?? '' })}>
          Write a new version
        </button>
      )}
      {draft && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>New version (draft)</h2>
          <form
            className="stack"
            style={{ maxWidth: 'none' }}
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await action.run(() => api(`/admin/contracts/templates/${product}`, { body: draft }));
              if (ok) (setDraft(null), reload());
            }}
          >
            <label>
              Title
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required minLength={3} />
            </label>
            <label>
              Wording. Use placeholders like {'{{borrower.name}}'} and {'{{total.payable}}'}; unknown ones are rejected.
              <textarea rows={22} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} required />
            </label>
            <div className="row">
              <button disabled={action.busy}>Save draft</button>
              <button type="button" className="secondary" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      {data?.templates.map((t) => (
        <TemplateCard key={t.id} t={t} canApprove={can('manager') && t.status === 'draft' && t.createdBy !== claims?.sub} onDone={reload} />
      ))}
    </Page>
  );
}

function TemplateCard({ t, canApprove, onDone }: { t: Template; canApprove: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const action = useAction();
  return (
    <div className="panel">
      <div className="page-head">
        <h2 style={{ margin: 0 }}>
          v{t.version} · {t.title}
        </h2>
        <span className={`badge ${t.status === 'approved' ? 'good' : t.status === 'draft' ? 'warn' : 'neutral'}`}>{t.status}</span>
      </div>
      {t.isPlaceholder && <Notice>Placeholder wording. Not reviewed by a lawyer.</Notice>}
      <p className="muted">
        Created {dateTime(t.createdAt)}
        {t.approvedAt && ` · approved ${dateTime(t.approvedAt)}: ${t.legalReviewNote}`}
      </p>
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? 'Hide wording' : 'Show wording'}
      </button>
      {open && <pre style={{ marginTop: 8 }}>{t.body}</pre>}
      {canApprove && (
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() => api(`/admin/contracts/templates/${t.id}/approve`, { body: { legalReviewNote: note } })).then((ok) => ok && onDone());
          }}
        >
          <label style={{ flex: 1 }}>
            Legal review note (who reviewed it, when)
            <input value={note} onChange={(e) => setNote(e.target.value)} required minLength={5} />
          </label>
          <button disabled={action.busy}>Approve this version</button>
        </form>
      )}
      <ErrorBox error={action.error} />
    </div>
  );
}
