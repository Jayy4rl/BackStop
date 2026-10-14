import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { ApiError } from '../lib/api';

export function Field(props: { label: string; hint?: ReactNode; error?: string | null; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const hintId = props.hint ? `${id}-hint` : undefined;
  const errId = props.error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.children(id, describedBy)}
      {props.hint && (
        <div className="hint" id={hintId}>
          {props.hint}
        </div>
      )}
      {props.error && (
        <div className="err" id={errId} role="alert">
          {props.error}
        </div>
      )}
    </div>
  );
}

export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return <Notice kind="danger">{msg}</Notice>;
}

const STATUS: Record<string, { label: string; kind: string }> = {
  available: { label: 'Available', kind: 'ok' },
  on_hold: { label: 'On hold', kind: 'danger' },
  under_review: { label: 'Under review', kind: 'warn' },
  unrecognised: { label: 'Unrecognised token', kind: 'warn' },
  unsupported_pair: { label: 'Unsupported network', kind: 'warn' },
  pending: { label: 'Pending', kind: 'info' },
  prepared: { label: 'Not sent', kind: 'info' },
  submitted: { label: 'Submitted', kind: 'info' },
  confirmed: { label: 'Confirmed', kind: 'info' },
  final: { label: 'Final', kind: 'ok' },
  failed: { label: 'Failed', kind: 'danger' },
  created: { label: 'Awaiting funding', kind: 'info' },
  funded: { label: 'Held in escrow', kind: 'ok' },
  delivered: { label: 'Delivered, on hold', kind: 'info' },
  disputed: { label: 'Disputed', kind: 'warn' },
  released: { label: 'Released', kind: 'ok' },
  refunded: { label: 'Refunded', kind: 'info' },
  cancelled: { label: 'Cancelled', kind: 'info' },
  open: { label: 'Open', kind: 'info' },
  granted: { label: 'Granted', kind: 'ok' },
  upheld: { label: 'Upheld', kind: 'warn' },
  confirmed_listing: { label: 'Confirmed', kind: 'danger' },
  reported: { label: 'Reported', kind: 'warn' },
  under_appeal: { label: 'Under appeal', kind: 'warn' },
  escrowed: { label: 'USDT in escrow', kind: 'ok' },
  paid: { label: 'Buyer marked paid', kind: 'info' },
  awaiting_escrow: { label: 'Awaiting seller', kind: 'info' },
  allow: { label: 'Clear', kind: 'ok' },
  warn: { label: 'Warning', kind: 'warn' },
  block: { label: 'Blocked', kind: 'danger' },
};

export function Status({ value }: { value: string }) {
  const s = STATUS[value] ?? { label: value.replace(/_/g, ' '), kind: '' };
  return <span className={`badge ${s.kind}`}>{s.label}</span>;
}

export function Money({ amount, token }: { amount: string; token?: string }) {
  const [w = '0', f = ''] = amount.split('.');
  const display = `${Number(w).toLocaleString('en-US')}.${(f + '00').slice(0, Math.max(2, f.replace(/0+$/, '').length))}`;
  return (
    <span>
      ${display}
      {token ? <span className="muted"> {token}</span> : null}
    </span>
  );
}

export function Qr({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string>('');
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: 180 }).then(setSrc).catch(() => setSrc(''));
  }, [value]);
  return <div className="qr">{src ? <img src={src} width={180} height={180} alt={label} /> : null}</div>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <div className="spread">
          <h2 id={id}>{title}</h2>
          <button className="btn link" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn secondary"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      <span aria-live="polite">{done ? 'Copied' : label}</span>
    </button>
  );
}

export function When({ at }: { at: string | null | undefined }) {
  if (!at) return <span className="muted">—</span>;
  const d = new Date(at);
  return <time dateTime={d.toISOString()}>{d.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</time>;
}

export function Loading() {
  return (
    <p className="muted" role="status">
      Loading…
    </p>
  );
}

/** Loads data with loading/error state; `reload` refetches. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: unknown; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), loading };
}

export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (...a: A): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn(...a);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, setError };
}
