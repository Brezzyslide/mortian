import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Notice, Page, useAction, useLoad } from '../components/ui';
import { dateTime, naira, toKobo } from '../format';

interface Item {
  eventId: string;
  provider: string;
  providerReference: string;
  accountNumber: string;
  amount: string;
  paidAt: string;
  problem: string;
  financeAccountReference: string | null;
}

const PROBLEM: Record<string, string> = {
  unknown_account_number: 'Paid to an unknown account number',
  conflicting_redelivery: 'Provider resent this reference with different details',
};

export function Exceptions() {
  const { data, error, reload } = useLoad(() => api<{ items: Item[] }>('/admin/payments/exceptions'), []);
  return (
    <Page title="Payment exceptions">
      <p className="muted">
        Every payment here is already recorded, so the bank balance and the ledger still match. Each one needs a person to decide where it
        belongs.
      </p>
      <ErrorBox error={error} />
      {data?.items.length === 0 && <p className="muted">Nothing to review.</p>}
      {data?.items.map((i) => (
        <ExceptionCard key={i.eventId} item={i} onDone={reload} />
      ))}
      <Simulator onDone={reload} />
    </Page>
  );
}

function ExceptionCard({ item, onDone }: { item: Item; onDone: () => void }) {
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const action = useAction();
  const unmatched = item.problem === 'unknown_account_number';
  return (
    <div className="panel">
      <div className="page-head">
        <h2 style={{ margin: 0 }}>
          {naira(item.amount)} · {PROBLEM[item.problem] ?? item.problem.replace(/_/g, ' ')}
        </h2>
        <span className="muted">{dateTime(item.paidAt)}</span>
      </div>
      <p className="muted">
        Provider {item.provider}, reference {item.providerReference}, paid to {item.accountNumber}
        {item.financeAccountReference && `, account ${item.financeAccountReference}`}
      </p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await action.run(() =>
            unmatched
              ? api(`/admin/payments/exceptions/${item.eventId}/assign`, { body: { financeAccountReference: ref.trim().toUpperCase(), note } })
              : api(`/admin/payments/exceptions/${item.eventId}/resolve`, { body: { note } }),
          );
          if (ok) onDone();
        }}
      >
        {unmatched && (
          <label>
            Belongs to account
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="FA-000123" required pattern="[Ff][Aa]-\d{6,}" />
          </label>
        )}
        <label style={{ flex: 1 }}>
          Note (what evidence you checked)
          <input value={note} onChange={(e) => setNote(e.target.value)} required minLength={5} />
        </label>
        <button disabled={action.busy}>{unmatched ? 'Move to account' : 'Mark reviewed'}</button>
      </form>
      <ErrorBox error={action.error} />
    </div>
  );
}

/** Sandbox only: the API returns 404 here once a real collections provider is configured. */
function Simulator({ onDone }: { onDone: () => void }) {
  const [accountNumber, setAccountNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const action = useAction();
  return (
    <div className="panel">
      <h2>Simulate a customer payment (sandbox)</h2>
      <Notice>Test money only. Not available once a real payment provider is connected.</Notice>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          await action.run(async () => {
            const r = await api<{ outcome: string }>('/admin/payments/sandbox/simulate', {
              body: { accountNumber, amountKobo: toKobo(amount) },
            });
            setResult(`Result: ${r.outcome}`);
            onDone();
          });
        }}
      >
        <label>
          Repayment account number
          <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))} maxLength={10} required />
        </label>
        <label>
          Amount (₦)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <button disabled={action.busy}>Send payment</button>
      </form>
      {result && <div className="ok">{result}</div>}
      <ErrorBox error={action.error} />
    </div>
  );
}
