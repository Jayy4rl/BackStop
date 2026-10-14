-- Off-chain bookkeeping for the protected-payment flow.

-- A dispute is recorded when a party asks to open it; it is live once the indexer sees the
-- on-chain Disputed event. Stale requests that never reach the chain are closed by the keeper.
ALTER TABLE network.disputes ADD COLUMN opened_onchain_at timestamptz;
ALTER TABLE network.disputes ADD COLUMN evidence_hash text;
-- C4-9: after a ruling, parties may request one second review before the arbiter executes.
ALTER TABLE network.disputes ADD COLUMN review_window_ends_at timestamptz;
ALTER TABLE network.disputes ADD COLUMN execution jsonb;

-- C4-10: either party may propose a mutual cancel; the payee executes it with refundByPayee.
ALTER TABLE app.payments ADD COLUMN cancel_requested_by uuid;
ALTER TABLE app.payments ADD COLUMN cancel_requested_at timestamptz;
-- Keeper bookkeeping (idempotent attempts, monitoring).
ALTER TABLE app.payments ADD COLUMN keeper_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE app.payments ADD COLUMN keeper_last_error text;
ALTER TABLE app.payments ADD COLUMN payer_confirmed_refund_address boolean NOT NULL DEFAULT false;
ALTER TABLE app.payments ADD COLUMN payer_email text;
ALTER TABLE app.payments ADD COLUMN funding_check_id uuid;

-- Signed documents (L3-3 proof of funds, L4-7 trade record, L2-6 invoices and receipts).
CREATE TABLE app.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('invoice', 'receipt', 'proof_of_funds', 'trade_record')),
  subject_id uuid NOT NULL,
  canonical text NOT NULL,
  signature text NOT NULL,
  public_key text NOT NULL,
  verify_code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX documents_one ON app.documents (kind, subject_id);
