import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Page, useLoad } from '../components/ui';
import { naira } from '../format';

interface Portfolio {
  asOf: string;
  buckets: Record<string, { accounts: number; principal: string }>;
  principalOutstanding: string;
  par30Percent: number;
}

const BUCKETS = ['current', '1-7', '8-30', '31-60', '61-90', '90+'];

export function Dashboard() {
  const { can } = useAuth();
  const showPortfolio = can('finance', 'manager');
  const portfolio = useLoad(() => (showPortfolio ? api<Portfolio>('/admin/lending/portfolio') : Promise.resolve(null)), [showPortfolio]);
  const approvals = useLoad(
    () => (can('manager') ? api<{ pending: unknown[] }>('/admin/lending/approvals') : Promise.resolve(null)),
    [can],
  );
  const queue = useLoad(
    () => (can('underwriter') ? api<{ accounts: unknown[] }>('/admin/lending/accounts?status=applied') : Promise.resolve(null)),
    [can],
  );

  const p = portfolio.data;
  return (
    <Page title="Overview">
      <div className="grid">
        {queue.data && (
          <Link className="stat" to="/applications">
            <div className="k">Applications waiting</div>
            <div className="v">{queue.data.accounts.length}</div>
          </Link>
        )}
        {approvals.data && (
          <Link className="stat" to="/approvals">
            <div className="k">Approvals waiting for you</div>
            <div className="v">{approvals.data.pending.length}</div>
          </Link>
        )}
        {p && (
          <>
            <div className="stat">
              <div className="k">Principal outstanding</div>
              <div className="v">{naira(p.principalOutstanding)}</div>
            </div>
            <div className="stat">
              <div className="k">PAR30</div>
              <div className="v">{p.par30Percent}%</div>
            </div>
          </>
        )}
      </div>

      {p && (
        <>
          <h2>Portfolio by days overdue (as of {p.asOf})</h2>
          <table>
            <thead>
              <tr>
                <th>Days overdue</th>
                <th className="num">Accounts</th>
                <th className="num">Principal outstanding</th>
              </tr>
            </thead>
            <tbody>
              {BUCKETS.map((b) => (
                <tr key={b}>
                  <td>{b === 'current' ? 'Current' : b}</td>
                  <td className="num">{p.buckets[b]?.accounts ?? 0}</td>
                  <td className="num">{naira(p.buckets[b]?.principal ?? '0')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <ErrorBox error={portfolio.error ?? approvals.error ?? queue.error} />
    </Page>
  );
}
