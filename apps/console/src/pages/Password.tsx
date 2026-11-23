import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Page, useAction } from '../components/ui';

export function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await action.run(async () => {
      if (next !== confirm) throw new Error('The new passwords do not match');
      await api('/me/password', { body: { currentPassword: current, newPassword: next } });
    });
    if (ok) (setDone(true), setCurrent(''), setNext(''), setConfirm(''));
  }

  return (
    <Page title="Change password">
      <div className="panel">
        <form className="stack" onSubmit={submit}>
          <label>
            Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            New password (at least 12 characters)
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} required />
          </label>
          <label>
            Repeat new password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          <button disabled={action.busy}>Change password</button>
        </form>
        {done && <div className="ok">Password changed. You stay signed in here; other devices were signed out.</div>}
        <ErrorBox error={action.error} />
      </div>
    </Page>
  );
}
