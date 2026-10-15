// First page for visitors: what Backstop is, the problem it solves, and one way in ("Launch App").
import { Link, useSearchParams } from 'react-router-dom';
import { LaunchButton } from '../lib/demo';

const BENEFITS = [
  {
    title: 'Checked before it leaves',
    text: 'Every address is screened against fraud reports and sanctions lists, and the name on the account is matched before you confirm.',
    icon: <path d="M12 3l7 3v5c0 4.5-3 8.3-7 9.5C8 19.3 5 15.5 5 11V6l7-3zm-3.2 9.2l2.2 2.2 4.4-4.6" />,
  },
  {
    title: 'Held until they deliver',
    text: 'Invoices, supplier orders and P2P trades pay into an on-chain escrow. It releases on delivery, or refunds if the deadline passes.',
    icon: <path d="M7 10V8a5 5 0 0110 0v2m-11 0h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zm6 4v2" />,
  },
  {
    title: 'A reason for every hold',
    text: 'If a payment is paused you see exactly why and what happens next. Anyone can appeal a listing.',
    icon: <path d="M4 20V5m0 0h11l-2 3.5L15 12H4m0-7" />,
  },
];

/** Only same-app paths, never another origin. */
function safeNext(v: string | null): string {
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

export function Landing() {
  const [q] = useSearchParams();
  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="logo">Backstop</span>
        <span className="chip">Sandbox · test money</span>
      </header>
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">USDT and USDC wallet for Nigeria</p>
            <h1 id="hero-title">Pay anyone. Get what you paid for.</h1>
            <p className="lede">Crypto payments can't be reversed. Backstop checks every address before you send and holds money paid to strangers until they deliver.</p>
            <div className="hero-cta">
              <LaunchButton next={safeNext(q.get('next'))} className="btn btn-lg" />
            </div>
            <p className="small muted">No sign-up. Your wallet keys stay on this device.</p>
          </div>
          <HeroVisual />
        </section>
        <section className="benefits" aria-label="Why Backstop">
          {BENEFITS.map((b) => (
            <div className="benefit" key={b.title}>
              <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {b.icon}
              </svg>
              <h2>{b.title}</h2>
              <p>{b.text}</p>
            </div>
          ))}
        </section>
      </main>
      <footer className="landing-foot small muted">
        <span>Address flagged by mistake?</span> <Link to="/appeal">Appeal a listing</Link>
      </footer>
    </div>
  );
}

/** Illustration of the two core moments: the pre-send check and an escrow holding funds. */
function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="mock mock-check">
        <div className="spread">
          <strong>Safety check</strong>
          <span className="badge ok">Safe to send</span>
        </div>
        <div className="mock-to">
          <span className="avatar">TB</span>
          <div>
            <div>@tunde</div>
            <div className="small muted">TUNDE BAKARE · verified</div>
          </div>
          <span className="mock-amt">$250.00</span>
        </div>
        <ul className="mock-list">
          <li>Name matches the account</li>
          <li>Not on the fraud list</li>
          <li>Sanctions screening clear</li>
        </ul>
      </div>
      <div className="mock mock-escrow">
        <div className="spread">
          <strong>Held in escrow</strong>
          <span className="badge info">Supplier order</span>
        </div>
        <div className="big">$1,200.00</div>
        <ol className="mock-steps">
          <li className="done">Funded</li>
          <li className="done">Shipped</li>
          <li>Released on delivery</li>
        </ol>
      </div>
    </div>
  );
}
