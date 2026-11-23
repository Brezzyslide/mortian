import { useState, type FormEvent } from 'react';
import { brand } from '@project/domain';
import { api } from '../api';
import { ErrorBox, useAction } from '../components/ui';

/** Opened from a one-time setup link. The token sits in the URL fragment and is never sent anywhere but the setup call. */
export function Setup() {
  const [token] = useState(() => window.location.hash.replace(/^#/, ''));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      if (password !== confirm) throw new Error('The two passwords do not match');
      const r = await api<{ email: string }>('/auth/staff/setup', { body: { token, password } });
      // Drop the used token from the address bar and history.
      window.history.replaceState(null, '', '/console/setup');
      setDone(r.email);
    });
  }

  return (
    <main className="login">
      <h1>{brand.name} console</h1>
      {done ? (
        <>
          <div className="ok">Password set for {done}.</div>
          <p>Next, sign in. You will be asked to set up an authenticator app on your phone.</p>
          <a href="/console/">Go to sign-in</a>
        </>
      ) : !token ? (
        <div className="error">This setup link is incomplete. Ask your administrator for a new one.</div>
      ) : (
        <form onSubmit={submit}>
          <p className="muted">Choose a password of at least 12 characters. A short sentence works well.</p>
          <label>
            New password
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required />
          </label>
          <label>
            Repeat it
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          <button disabled={action.busy}>Set password</button>
        </form>
      )}
      <ErrorBox error={action.error instanceof Error && action.error.message === 'setup_invalid'
        ? new Error('This link has expired or was already used. Ask your administrator for a new one.')
        : action.error} />
    </main>
  );
}
