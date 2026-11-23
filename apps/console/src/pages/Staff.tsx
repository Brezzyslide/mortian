import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Notice, Page, useAction, useLoad } from '../components/ui';
import { dateTime } from '../format';

export const STAFF_ROLES = ['underwriter', 'collections', 'dispatch_ops', 'finance', 'manager', 'super_admin'] as const;

interface Member {
  id: string;
  email: string;
  fullName: string | null;
  status: string;
  roles: string[];
  passwordSet: boolean;
  authenticatorEnrolled: boolean;
  lockedUntil: string | null;
  pendingSetup: { purpose: string; expiresAt: string } | null;
}

interface Link {
  setupToken: string;
  expiresAt: string;
}

/** The link carries the token in the URL fragment, which browsers never send to a server or put in Referer. */
export function setupUrl(token: string): string {
  return `${window.location.origin}/console/setup#${token}`;
}

export function Staff() {
  const { claims } = useAuth();
  const { data, error, reload } = useLoad(() => api<{ staff: Member[] }>('/admin/staff'), []);
  const [shown, setShown] = useState<{ who: string; link: Link } | null>(null);

  return (
    <Page title="Staff">
      <ErrorBox error={error} />
      {shown && <LinkBox who={shown.who} link={shown.link} onClose={() => setShown(null)} />}
      <InviteForm onInvited={(who, link) => (setShown({ who, link }), reload())} />
      <table>
        <thead>
          <tr>
            <th>Person</th>
            <th>Roles</th>
            <th>Sign-in</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.staff.map((m) => (
            <Row key={m.id} m={m} self={m.id === claims?.sub} onLink={(link) => setShown({ who: m.email, link })} onDone={reload} />
          ))}
        </tbody>
      </table>
    </Page>
  );
}

function LinkBox({ who, link, onClose }: { who: string; link: Link; onClose: () => void }) {
  const url = setupUrl(link.setupToken);
  const [copied, setCopied] = useState(false);
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>One-time setup link for {who}</h2>
      <Notice>
        Shown once. Send it to them privately (not in a group chat). It works once and expires {dateTime(link.expiresAt)}.
      </Notice>
      <div className="row">
        <input readOnly value={url} aria-label="Setup link" style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

function RolePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="row">
      {STAFF_ROLES.map((r) => (
        <label key={r} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, color: 'var(--ink)' }}>
          <input
            type="checkbox"
            checked={value.includes(r)}
            onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))}
          />
          {r.replace('_', ' ')}
        </label>
      ))}
    </div>
  );
}

function InviteForm({ onInvited }: { onInvited: (who: string, link: Link) => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const action = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const r = await api<Link & { id: string }>('/admin/staff', { body: { email, fullName, roles } });
      onInvited(email, r);
      setEmail('');
      setFullName('');
      setRoles([]);
    });
  }
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Invite a staff member</h2>
      <form className="stack" style={{ maxWidth: 'none' }} onSubmit={submit}>
        <div className="row">
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Full name
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
          </label>
        </div>
        <RolePicker value={roles} onChange={setRoles} />
        <div>
          <button disabled={action.busy || roles.length === 0}>Create and get setup link</button>
        </div>
      </form>
      <ErrorBox error={action.error} />
    </div>
  );
}

function Row({ m, self, onLink, onDone }: { m: Member; self: boolean; onLink: (l: Link) => void; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [roles, setRoles] = useState(m.roles);
  const action = useAction();
  const post = (path: string) => action.run(() => api(`/admin/staff/${m.id}/${path}`, { body: {} })).then((ok) => ok && onDone());

  return (
    <tr>
      <td>
        {m.fullName ?? '—'}
        <div className="muted">{m.email}</div>
      </td>
      <td>
        {editing ? (
          <>
            <RolePicker value={roles} onChange={setRoles} />
            <div className="row" style={{ marginTop: 6 }}>
              <button
                disabled={action.busy || roles.length === 0}
                onClick={() =>
                  void action
                    .run(() => api(`/admin/staff/${m.id}/roles`, { method: 'PUT', body: { roles } }))
                    .then((ok) => ok && (setEditing(false), onDone()))
                }
              >
                Save
              </button>
              <button className="secondary" onClick={() => (setEditing(false), setRoles(m.roles))}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          m.roles.join(', ')
        )}
      </td>
      <td>
        {!m.passwordSet
          ? m.pendingSetup
            ? `Waiting for setup (link expires ${dateTime(m.pendingSetup.expiresAt)})`
            : 'No password: link expired'
          : m.authenticatorEnrolled
            ? 'Password + authenticator'
            : 'Authenticator not set up yet'}
        {m.lockedUntil && <div className="badge warn">Locked until {dateTime(m.lockedUntil)}</div>}
      </td>
      <td>
        <span className={`badge ${m.status === 'active' ? 'good' : 'bad'}`}>{m.status}</span>
      </td>
      <td>
        <div className="row" style={{ gap: 8 }}>
          {!editing && (
            <button className="link" onClick={() => setEditing(true)}>
              Roles
            </button>
          )}
          {!self && m.status === 'active' && (
            <button className="link" onClick={() => window.confirm(`Suspend ${m.email}? They are signed out at once.`) && void post('suspend')}>
              Suspend
            </button>
          )}
          {!self && m.status !== 'active' && (
            <button className="link" onClick={() => void post('reactivate')}>
              Reactivate
            </button>
          )}
          {!self && m.passwordSet && (
            <button
              className="link"
              onClick={() =>
                window.confirm(`Reset access for ${m.email}? Their password and authenticator stop working now.`) &&
                void action
                  .run(async () => onLink(await api<Link>(`/admin/staff/${m.id}/reset-access`, { body: {} })))
                  .then((ok) => ok && onDone())
              }
            >
              Reset access
            </button>
          )}
          {!m.passwordSet && (
            <button
              className="link"
              onClick={() =>
                void action.run(async () => onLink(await api<Link>(`/admin/staff/${m.id}/reissue-link`, { body: {} }))).then((ok) => ok && onDone())
              }
            >
              New link
            </button>
          )}
        </div>
        <ErrorBox error={action.error} />
      </td>
    </tr>
  );
}
