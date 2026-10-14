import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { Loading, Notice } from './components/ui';
import { Welcome, SignIn, Recover } from './pages/Auth';
import { SignUp } from './pages/SignUp';
import { Home } from './pages/Home';
import { Send } from './pages/Send';
import { Receive } from './pages/Receive';
import { History, TransferPage } from './pages/History';
import { Requests, PayRequest } from './pages/Requests';
import { Invoices, NewInvoice, InvoiceDetail } from './pages/Invoices';
import { Orders, NewOrder, OrderDetail } from './pages/Orders';
import { PaymentPage } from './pages/Payment';
import { P2P, TradeRoom } from './pages/P2P';
import { Verification } from './pages/Verification';
import { Settings } from './pages/Settings';
import { Support } from './pages/Support';
import { ReportFraud } from './pages/Report';
import { Checkout } from './pages/Checkout';
import { SupplierOrder } from './pages/SupplierOrder';
import { Appeal, AppealStatus } from './pages/Appeal';
import { VerifyDocument } from './pages/VerifyDocument';
import { Profile } from './pages/Profile';
import { t } from './lib/i18n';

// Staff tools load separately so customers never download them.
const StaffApp = lazy(() => import('./staff/StaffApp').then((m) => ({ default: m.StaffApp })));

function Shell({ children }: { children: ReactNode }) {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const links: Array<[string, string]> = [
    ['/', t('nav.home')],
    ['/send', t('nav.send')],
    ['/receive', t('nav.receive')],
    ['/history', t('nav.history')],
    ['/requests', t('nav.requests')],
    ['/invoices', t('nav.invoices')],
    ['/orders', t('nav.orders')],
    ['/p2p', t('nav.p2p')],
    ['/verify-identity', t('nav.verify')],
    ['/support', t('nav.support')],
    ['/settings', t('nav.settings')],
  ];
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="topbar">
        <strong style={{ color: 'var(--brand)' }}>Backstop</strong>
        <button className="btn secondary" aria-expanded={open} aria-controls="sidenav" onClick={() => setOpen((x) => !x)}>
          Menu
        </button>
      </div>
      <div className="shell">
        <aside className={`side ${open ? 'open' : ''}`} id="sidenav">
          <div className="spread">
            <div className="logo">Backstop</div>
            {open && (
              <button className="btn link" onClick={() => setOpen(false)}>
                Close
              </button>
            )}
          </div>
          <nav aria-label="Main">
            {links.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div style={{ padding: '16px 12px' }} className="small muted">
            Signed in as <strong>{me?.handle ? `@${me.handle}` : me?.email}</strong>
            <br />
            <button className="btn link" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="main" id="main" tabIndex={-1}>
          {me?.status === 'suspended' && <Notice kind="danger" title="Account suspended">{me.suspendedReason} Contact support to appeal.</Notice>}
          {me?.reverifyRequired && (
            <Notice kind="warn" title="Verify it's you">
              {me.reverifyReason === 'phone_changed' ? 'Your phone number changed.' : 'You signed in on a new device.'} Sends and releases are paused until you verify. <NavLink to="/settings#reverify">Verify now</NavLink>
            </Notice>
          )}
          {me?.outgoingLockedUntil && new Date(me.outgoingLockedUntil) > new Date() && (
            <Notice kind="warn" title="Recovery lock">Your wallet was recovered. Outgoing transfers are locked until {new Date(me.outgoingLockedUntil).toLocaleString()} to protect you.</Notice>
          )}
          {children}
        </main>
      </div>
    </>
  );
}

function Private({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/welcome?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <Shell>{children}</Shell>;
}

function Public({ children }: { children: ReactNode }) {
  return (
    <main className="public" id="main">
      <div className="logo" style={{ fontWeight: 800, fontSize: '1.3rem', color: 'var(--brand)', marginBottom: 20 }}>
        Backstop
      </div>
      {children}
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/welcome" element={<Public><Welcome /></Public>} />
      <Route path="/signup" element={<Public><SignUp /></Public>} />
      <Route path="/signin" element={<Public><SignIn /></Public>} />
      <Route path="/recover" element={<Public><Recover /></Public>} />
      <Route path="/checkout/:slug" element={<Public><Checkout /></Public>} />
      <Route path="/orders/:slug" element={<Public><SupplierOrder /></Public>} />
      <Route path="/pay/:slug" element={<Public><PayRequest /></Public>} />
      <Route path="/appeal" element={<Public><Appeal /></Public>} />
      <Route path="/appeal/:ref" element={<Public><AppealStatus /></Public>} />
      <Route path="/verify/:code" element={<Public><VerifyDocument /></Public>} />
      <Route path="/u/:handle" element={<Public><Profile /></Public>} />
      <Route path="/staff/*" element={<Suspense fallback={<Loading />}><StaffApp /></Suspense>} />

      <Route path="/" element={<Private><Home /></Private>} />
      <Route path="/send" element={<Private><Send /></Private>} />
      <Route path="/receive" element={<Private><Receive /></Private>} />
      <Route path="/history" element={<Private><History /></Private>} />
      <Route path="/transfers/:id" element={<Private><TransferPage /></Private>} />
      <Route path="/requests" element={<Private><Requests /></Private>} />
      <Route path="/invoices" element={<Private><Invoices /></Private>} />
      <Route path="/invoices/new" element={<Private><NewInvoice /></Private>} />
      <Route path="/invoices/:id" element={<Private><InvoiceDetail /></Private>} />
      <Route path="/orders" element={<Private><Orders /></Private>} />
      <Route path="/orders/new" element={<Private><NewOrder /></Private>} />
      <Route path="/my-orders/:id" element={<Private><OrderDetail /></Private>} />
      <Route path="/payments/:id" element={<Private><PaymentPage /></Private>} />
      <Route path="/p2p" element={<Private><P2P /></Private>} />
      <Route path="/p2p/trades/:id" element={<Private><TradeRoom /></Private>} />
      <Route path="/verify-identity" element={<Private><Verification /></Private>} />
      <Route path="/settings" element={<Private><Settings /></Private>} />
      <Route path="/support" element={<Private><Support /></Private>} />
      <Route path="/report" element={<Private><ReportFraud /></Private>} />
      <Route path="*" element={<Public><h1>Page not found</h1><a href="/">Go home</a></Public>} />
    </Routes>
  );
}
