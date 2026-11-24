import { useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorBox, Notice, Page, useLoad } from '../components/ui';

interface Message {
  to: string;
  templateId: string;
  vars: Record<string, string>;
}

/**
 * Sandbox only: every SMS the platform would have sent, newest first. This is how testers get
 * login codes and signing links without an SMS provider. The API answers 404 once a real
 * provider is configured, and this page then says so.
 */
export function SandboxInbox() {
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState('');
  const { data, error, reload } = useLoad(
    () => api<{ messages: Message[] }>(`/admin/sandbox/messages${filter ? `?to=${encodeURIComponent(filter)}` : ''}`),
    [filter],
  );
  const notSandbox = error instanceof ApiError && error.status === 404;
  return (
    <Page title="Sandbox SMS" actions={<button className="secondary" onClick={reload}>Refresh</button>}>
      <Notice>Messages are held in the API's memory and disappear when it restarts. Nothing here reaches a real phone.</Notice>
      {notSandbox ? (
        <p className="muted">A real SMS provider is configured, so there is no sandbox inbox.</p>
      ) : (
        <ErrorBox error={error} />
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter(to.trim());
        }}
      >
        <label style={{ flex: 1 }}>
          Only messages to (+234…)
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+2348031234567" />
        </label>
        <button className="secondary">Filter</button>
      </form>
      {data?.messages.length === 0 && <p className="muted">No messages yet.</p>}
      {data && data.messages.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>To</th>
              <th>Message</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {data.messages.map((m, i) => (
              <tr key={i}>
                <td>{m.to}</td>
                <td>{m.templateId.replace(/_/g, ' ')}</td>
                <td>
                  {Object.entries(m.vars).map(([k, v]) => (
                    <div key={k}>
                      <span className="muted">{k}: </span>
                      {/^https?:\/\//.test(v) ? (
                        <a href={v} target="_blank" rel="noreferrer">
                          open link
                        </a>
                      ) : (
                        <strong>{v}</strong>
                      )}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
