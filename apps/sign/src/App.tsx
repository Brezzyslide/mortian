import { useEffect, useRef, useState, type FormEvent } from 'react';
import { brand } from '@project/domain';
import { deviceId, forgetToken, message, signApi, takeToken, type SigningView } from './api';
import { SignaturePad } from './SignaturePad';

type Step = 'loading' | 'read' | 'otp' | 'sign' | 'done' | 'declined' | 'error';

export function App() {
  const [token] = useState(takeToken);
  const [view, setView] = useState<SigningView | null>(null);
  const [step, setStep] = useState<Step>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This link is incomplete. Open it again from the SMS we sent you.');
      setStep('error');
      return;
    }
    signApi
      .view(token)
      .then((v) => {
        setView(v);
        setStep(v.otpVerified ? 'sign' : 'read');
      })
      .catch((e) => {
        setError(message(e));
        setStep('error');
      });
  }, [token]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <header>
        <strong>{brand.name}</strong>
        {view && <span className="muted"> · agreement {view.reference}</span>}
      </header>

      {view?.isPlaceholder && step !== 'done' && (
        <div className="warn" role="note">
          Test agreement with placeholder wording. Do not sign this as a real agreement.
        </div>
      )}

      {step === 'loading' && <p className="muted">Loading your agreement…</p>}

      {step === 'error' && <div className="error" role="alert">{error}</div>}

      {view && step === 'read' && <Read view={view} onDone={() => setStep('otp')} onDecline={() => setStep('declined')} token={token!} />}

      {view && step === 'otp' && (
        <Otp
          view={view}
          busy={busy}
          onSend={() => run(async () => void (await signApi.otp(token!)))}
          onVerify={(code) => run(async () => (await signApi.verify(token!, code), setStep('sign')))}
        />
      )}

      {view && step === 'sign' && (
        <Sign
          view={view}
          busy={busy}
          onSign={(input) =>
            run(async () => {
              const r = await signApi.complete({ token: token!, documentSha256: view.documentSha256, deviceId: deviceId(), intentToSign: true, ...input });
              forgetToken();
              setNext(r.next);
              setStep('done');
            })
          }
        />
      )}

      {step === 'done' && (
        <section>
          <div className="ok" role="status">
            Thank you, {view?.signerName}. Your signature has been recorded.
          </div>
          <p>
            {next === 'guarantor'
              ? 'Your guarantor will now get their own SMS link to sign on their phone.'
              : 'The company will now countersign. We will send you a copy of the signed agreement.'}
          </p>
          <p className="muted">You can close this page.</p>
        </section>
      )}

      {step === 'declined' && view && <Decline token={token!} view={view} onBack={() => setStep('read')} />}

      {error && step !== 'error' && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <footer className="muted">
        Questions? Call {brand.supportPhone}.
      </footer>
    </main>
  );
}

function Read({ view, token: _token, onDone, onDecline }: { view: SigningView; token: string; onDone: () => void; onDecline: () => void }) {
  const [reachedEnd, setReachedEnd] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const check = () => {
    const el = box.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setReachedEnd(true);
  };
  useEffect(check, []);
  return (
    <section>
      <h1>{view.role === 'guarantor' ? `Guarantee for ${view.reference}` : 'Your agreement'}</h1>
      <p>
        Hello {view.signerName}. Please read the whole agreement. {view.role === 'guarantor' && 'You are being asked to be a guarantor.'}
      </p>
      <div className="doc" ref={box} onScroll={check} tabIndex={0} aria-label="Agreement text">
        {view.documentText}
      </div>
      <button disabled={!reachedEnd} onClick={onDone}>
        {reachedEnd ? 'I have read it, continue' : 'Scroll to the end to continue'}
      </button>
      <button className="link" onClick={onDecline}>
        I do not want to sign
      </button>
    </section>
  );
}

function Otp({ view, busy, onSend, onVerify }: { view: SigningView; busy: boolean; onSend: () => Promise<void>; onVerify: (code: string) => Promise<void> }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  return (
    <section>
      <h1>Confirm it is you</h1>
      <p>We will text a 6-digit code to {view.phone}.</p>
      {!sent ? (
        <button disabled={busy} onClick={() => void onSend().then(() => setSent(true))}>
          Send code
        </button>
      ) : (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void onVerify(code);
          }}
        >
          <label>
            Code from SMS
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </label>
          <button disabled={busy || code.length !== 6}>Confirm</button>
          <button type="button" className="link" disabled={busy} onClick={() => void onSend()}>
            Send a new code
          </button>
        </form>
      )}
    </section>
  );
}

function Sign({
  view,
  busy,
  onSign,
}: {
  view: SigningView;
  busy: boolean;
  onSign: (i: { acknowledged: string[]; typedName: string; signaturePngBase64?: string }) => Promise<void>;
}) {
  const [ticked, setTicked] = useState<string[]>([]);
  const [intent, setIntent] = useState(false);
  const [name, setName] = useState('');
  const [png, setPng] = useState<string | null>(null);
  const all = view.keyTerms.every((t) => ticked.includes(t.key));
  const ready = all && intent && name.trim().length >= 2;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSign({ acknowledged: ticked, typedName: name, ...(png ? { signaturePngBase64: png } : {}) });
      }}
    >
      <h1>Check and sign</h1>
      <p>Tick each item to confirm you understand it.</p>
      <ul className="terms">
        {view.keyTerms.map((t) => (
          <li key={t.key}>
            <label className="check">
              <input
                type="checkbox"
                checked={ticked.includes(t.key)}
                onChange={(e) => setTicked(e.target.checked ? [...ticked, t.key] : ticked.filter((k) => k !== t.key))}
              />
              <span>{t.text}</span>
            </label>
          </li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={intent} onChange={(e) => setIntent(e.target.checked)} />
        <span>
          <strong>I want to sign this agreement</strong> and I understand it is legally binding.
        </span>
      </label>
      <label>
        Your full name
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder={view.signerName} />
      </label>
      <p className="muted">Optional: draw your signature with your finger.</p>
      <SignaturePad onChange={setPng} />
      <button disabled={busy || !ready}>Sign agreement</button>
      <p className="muted small">Document check: {view.documentSha256.slice(0, 16)}…</p>
    </form>
  );
}

function Decline({ token, view, onBack }: { token: string; view: SigningView; onBack: () => void }) {
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) return <div className="ok">You declined. {view.role === 'guarantor' ? 'The borrower and our team have been told.' : 'Our team will contact you.'}</div>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        signApi
          .decline(token, reason)
          .then(() => (forgetToken(), setDone(true)))
          .catch((err) => setError(message(err)));
      }}
    >
      <h1>Decline to sign</h1>
      <p>This cancels the agreement. Tell us why, so we can help.</p>
      <label>
        Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
      </label>
      <button className="danger">Decline</button>
      <button type="button" className="link" onClick={onBack}>
        Go back
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
