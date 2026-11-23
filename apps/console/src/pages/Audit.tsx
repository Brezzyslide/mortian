import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Page, useLoad } from '../components/ui';
import { dateTime } from '../format';

interface Event {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_kind: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  details: Record<string, unknown>;
}

export function Audit() {
  const [filter, setFilter] = useState('');
  const [subject, setSubject] = useState('');
  const { data, error } = useLoad(
    () => api<{ events: Event[] }>(`/admin/audit?limit=200${subject ? `&subjectId=${encodeURIComponent(subject)}` : ''}`),
    [subject],
  );
  const apply = (e: FormEvent) => (e.preventDefault(), setSubject(filter.trim()));

  return (
    <Page
      title="Audit log"
      actions={
        <form onSubmit={apply} className="row">
          <input aria-label="Subject" placeholder="FA-000123 or an id" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="secondary">Filter</button>
        </form>
      }
    >
      <p className="muted">Append-only: the database refuses edits and deletions. Newest first.</p>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Subject</th>
            <th>By</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {data?.events.map((e) => (
            <tr key={e.id}>
              <td>{dateTime(e.occurred_at)}</td>
              <td>
                <code>{e.action}</code>
              </td>
              <td>{e.subject_id ?? '—'}</td>
              <td className="muted">{e.actor_kind === 'person' ? e.actor_id?.slice(0, 8) : e.actor_kind}</td>
              <td>{Object.keys(e.details).length ? <pre>{JSON.stringify(e.details)}</pre> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
