import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Notice, Page, useAction, useLoad } from '../components/ui';
import { bps, dateTime, naira } from '../format';

interface Tier {
  id: string;
  tier: string;
  version: number;
  is_placeholder: boolean;
  created_at: string;
  config: {
    frequency: string;
    interestMethod: string;
    assetPriceKobo: { min: string; max: string };
    bounds: Record<string, { default: number; min: number; max: number }>;
  };
}

const PRODUCTS = ['motorcycle_ride_to_own', 'phone_financing', 'school_fee_financing', 'business_equipment_finance', 'purchase_and_deliver'];
const BPS_TERMS = new Set(['depositBps', 'annualInterestBps', 'penaltyBpsPerDay', 'guarantorMaxLiabilityBps']);

export function Tiers() {
  const { can } = useAuth();
  const [product, setProduct] = useState(PRODUCTS[0]!);
  const { data, error, reload } = useLoad(() => api<{ tiers: Tier[] }>(`/admin/lending/tiers/${product}`), [product]);
  const seed = useAction();

  return (
    <Page
      title="Tiers"
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
        Publishing creates a new version. Accounts already approved keep the terms they were approved on.
      </p>
      <ErrorBox error={error ?? seed.error} />
      {data?.tiers.length === 0 && (
        <p className="muted">
          No tiers for this product yet.
          {product === 'motorcycle_ride_to_own' && can('super_admin') && (
            <>
              {' '}
              <button className="link" onClick={() => void seed.run(() => api('/admin/lending/tiers/seed-placeholders', { body: {} })).then(reload)}>
                Load the labelled placeholder tiers
              </button>
            </>
          )}
        </p>
      )}
      {data?.tiers.map((t) => (
        <TierCard key={t.id} product={product} t={t} canPublish={can('manager')} onDone={reload} />
      ))}
    </Page>
  );
}

function TierCard({ product, t, canPublish, onDone }: { product: string; t: Tier; canPublish: boolean; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(JSON.stringify(t.config, null, 2));
  const [note, setNote] = useState('');
  const action = useAction();
  return (
    <div className="panel">
      <div className="page-head">
        <h2 style={{ margin: 0 }}>
          Tier {t.tier} · version {t.version}
        </h2>
        <span className="muted">{dateTime(t.created_at)}</span>
      </div>
      {t.is_placeholder && <Notice>Placeholder numbers, not real pricing.</Notice>}
      <p className="muted">
        {t.config.frequency} instalments, {t.config.interestMethod} interest, asset price {naira(t.config.assetPriceKobo.min)} –{' '}
        {naira(t.config.assetPriceKobo.max)}
      </p>
      <table>
        <thead>
          <tr>
            <th>Term</th>
            <th className="num">Default</th>
            <th className="num">Min</th>
            <th className="num">Max</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(t.config.bounds).map(([k, b]) => {
            const show = (n: number) => (BPS_TERMS.has(k) ? bps(n) : String(n));
            return (
              <tr key={k}>
                <td>{k}</td>
                <td className="num">{show(b.default)}</td>
                <td className="num">{show(b.min)}</td>
                <td className="num">{show(b.max)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canPublish && !editing && (
        <button className="secondary" style={{ marginTop: 12 }} onClick={() => setEditing(true)}>
          Publish a new version
        </button>
      )}
      {editing && (
        <form
          className="stack"
          style={{ marginTop: 12, maxWidth: 'none' }}
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await action.run(async () => {
              let config: unknown;
              try {
                config = JSON.parse(json);
              } catch {
                throw new Error('The configuration is not valid JSON');
              }
              await api(`/admin/lending/tiers/${product}/${t.tier}`, { body: { config, ...(note ? { note } : {}) } });
            });
            if (ok) (setEditing(false), onDone());
          }}
        >
          <p className="muted">
            Rates are basis points (100 = 1%), money is kobo as text (₦1 = "100"). The API rejects anything out of range.
          </p>
          <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={24} aria-label="Tier configuration" />
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change" />
          </label>
          <div className="row">
            <button disabled={action.busy}>Publish version {t.version + 1}</button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <ErrorBox error={action.error} />
        </form>
      )}
    </div>
  );
}
