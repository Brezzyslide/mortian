import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, type Tokens } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, useAction } from '../components/ui';
import { brand } from '@project/domain';

interface Step1 {
  challengeId: string;
  enrolmentRequired: boolean;
  enrolment?: { secret: string; otpauthUri: string };
}

export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step1 | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const action = useAction();

  useEffect(() => {
    if (step?.enrolment) void QRCode.toDataURL(step.enrolment.otpauthUri, { margin: 1, width: 200 }).then(setQr);
  }, [step]);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => setStep(await api<Step1>('/auth/staff/login', { body: { email, password } })));
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const t = await api<Tokens>('/auth/staff/mfa', { body: { challengeId: step!.challengeId, code } });
      setPassword('');
      signIn(t);
    });
  }

  return (
    <main className="login">
      <h1>{brand.name} console</h1>
      {!step ? (
        <form onSubmit={submitPassword}>
          <label>
            Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button disabled={action.busy}>Continue</button>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          {step.enrolmentRequired && step.enrolment && (
            <div className="enrol">
              <p>
                <strong>Set up your authenticator.</strong> Scan this code with Google Authenticator, Microsoft Authenticator or
                similar, then enter the 6-digit code it shows.
              </p>
              {qr && <img src={qr} alt="Authenticator setup QR code" width={200} height={200} />}
              <p className="muted">
                Can't scan? Enter this key manually: <code>{step.enrolment.secret}</code>
              </p>
            </div>
          )}
          <label>
            Authenticator code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
              autoFocus
            />
          </label>
          <button disabled={action.busy || code.length !== 6}>Sign in</button>
          <button type="button" className="link" onClick={() => (setStep(null), setCode(''))}>
            Start again
          </button>
        </form>
      )}
      <ErrorBox error={action.error} />
    </main>
  );
}
