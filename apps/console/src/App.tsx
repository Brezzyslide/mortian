import { useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { brand } from '@project/domain';
import { AuthProvider, useAuth } from './auth';
import { Account } from './pages/Account';
import { Applications } from './pages/Applications';
import { Approvals } from './pages/Approvals';
import { Arrears } from './pages/Arrears';
import { Audit } from './pages/Audit';
import { Dashboard } from './pages/Dashboard';
import { Exceptions } from './pages/Exceptions';
import { Login } from './pages/Login';
import { Password } from './pages/Password';
import { Setup } from './pages/Setup';
import { Staff } from './pages/Staff';
import { Products } from './pages/Products';
import { AssetDetail, Assets } from './pages/Assets';
import { Deliveries, DispatchPricing, Riders } from './pages/Dispatch';
import { Payouts } from './pages/Payouts';
import { SandboxInbox } from './pages/SandboxInbox';
import { Templates } from './pages/Templates';
import { Tiers } from './pages/Tiers';

interface NavItem {
  to: string;
  label: string;
  roles: string[];
  element: ReactNode;
}

/** Each screen lists the roles that may open it; the API enforces the same rules again. */
export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', roles: ['underwriter', 'collections', 'finance', 'manager'], element: <Dashboard /> },
  { to: '/applications', label: 'Applications', roles: ['underwriter', 'manager'], element: <Applications /> },
  { to: '/approvals', label: 'Approvals', roles: ['manager'], element: <Approvals /> },
  { to: '/arrears', label: 'Arrears', roles: ['collections', 'manager'], element: <Arrears /> },
  { to: '/exceptions', label: 'Payment exceptions', roles: ['finance'], element: <Exceptions /> },
  { to: '/deliveries', label: 'Deliveries', roles: ['dispatch_ops', 'finance', 'manager'], element: <Deliveries /> },
  { to: '/riders', label: 'Riders', roles: ['dispatch_ops', 'manager'], element: <Riders /> },
  { to: '/payouts', label: 'Rider payouts', roles: ['finance', 'manager'], element: <Payouts /> },
  { to: '/delivery-pricing', label: 'Delivery pricing', roles: ['dispatch_ops', 'finance', 'manager'], element: <DispatchPricing /> },
  { to: '/assets', label: 'Assets', roles: ['dispatch_ops', 'underwriter', 'collections', 'finance', 'manager'], element: <Assets /> },
  { to: '/tiers', label: 'Tiers', roles: ['underwriter', 'manager'], element: <Tiers /> },
  { to: '/templates', label: 'Contract templates', roles: ['underwriter', 'manager'], element: <Templates /> },
  { to: '/products', label: 'Products', roles: ['manager'], element: <Products /> },
  { to: '/audit', label: 'Audit log', roles: ['manager'], element: <Audit /> },
  { to: '/sandbox-sms', label: 'Sandbox SMS', roles: ['manager'], element: <SandboxInbox /> },
  { to: '/staff', label: 'Staff', roles: ['super_admin'], element: <Staff /> },
];

function AccountSearch() {
  const [ref, setRef] = useState('');
  const navigate = useNavigate();
  function go(e: FormEvent) {
    e.preventDefault();
    const r = ref.trim().toUpperCase();
    if (/^FA-\d{6,}$/.test(r)) navigate(`/accounts/${r}`);
  }
  return (
    <form className="search" onSubmit={go} role="search">
      <input aria-label="Account reference" placeholder="FA-000123" value={ref} onChange={(e) => setRef(e.target.value)} />
    </form>
  );
}

function Shell() {
  const { claims, can, signOut } = useAuth();
  const items = NAV.filter((n) => can(...n.roles));
  return (
    <div className="shell">
      <aside>
        <div className="brand">{brand.shortName}</div>
        <nav>
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="me">
          <div className="muted">{claims?.roles.join(', ')}</div>
          <NavLink to="/password" className="link">
            Change password
          </NavLink>{' '}
          ·{' '}
          <button className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <div className="topbar">
          <AccountSearch />
        </div>
        <Routes>
          {items.map((n) => (
            <Route key={n.to} path={n.to} element={n.element} />
          ))}
          {can('underwriter', 'collections', 'finance', 'manager') && <Route path="/accounts/:reference" element={<Account />} />}
          {can('dispatch_ops', 'underwriter', 'collections', 'finance', 'manager') && <Route path="/assets/:id" element={<AssetDetail />} />}
          <Route path="/password" element={<Password />} />
          {/* Unknown paths go to the first screen this person may see (not every role has Overview). */}
          <Route path="*" element={<Navigate to={items[0]?.to ?? '/password'} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Gate() {
  const { ready, claims } = useAuth();
  // Setup links work without a session (and whether or not one exists in this tab).
  if (window.location.pathname.replace(/\/$/, '') === '/console/setup') return <Setup />;
  if (!ready) return <p className="muted pad">Loading…</p>;
  if (!claims) return <Login />;
  if (claims.kind !== 'staff' || !claims.mfa) return <p className="pad">This console is for staff accounts only.</p>;
  return <Shell />;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename="/console">
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  );
}
