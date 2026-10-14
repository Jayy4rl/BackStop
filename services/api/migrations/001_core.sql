-- Backstop core schema.
-- PRD "Path to the service layer": every record carries a tenant ID (Backstop app = tenant 1);
-- fraud-list and dispute data live in the `network` schema, separate from app user data in `app`,
-- so the network could later move into a separate member-governed entity.
-- NFR Auditability: `audit.events` is append-only and hash-chained.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS network;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS config;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE app.tenants (
  id integer PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.tenants (id, name) VALUES (1, 'Backstop app');

-- ------------------------------------------------------------------ config (versioned data)

CREATE TABLE config.versions (
  kind text NOT NULL CHECK (kind IN ('rules', 'fees', 'limits')),
  version text NOT NULL,
  tenant_id integer NOT NULL REFERENCES app.tenants(id) DEFAULT 1,
  body jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, version)
);
CREATE UNIQUE INDEX config_one_active ON config.versions (tenant_id, kind) WHERE active;

CREATE TABLE config.holidays (
  day date PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE config.sanctioned_countries (
  country char(2) PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ app: identity (C1)

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL REFERENCES app.tenants(id) DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('individual', 'business', 'counterparty')),
  handle text,
  email text NOT NULL,
  email_verified_at timestamptz,
  phone_e164 text,
  phone_verified_at timestamptz,
  phone_discoverable boolean NOT NULL DEFAULT false,
  display_name text,
  verified_name text,
  country char(2) NOT NULL DEFAULT 'NG',
  tier text NOT NULL DEFAULT 'none' CHECK (tier IN ('none', 'tier1', 'tier2', 'counterparty')),
  counterparty_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  suspended_reason text,
  locale text NOT NULL DEFAULT 'en',
  new_payee_threshold_units numeric(78,0),
  -- C1-8: new device or changed phone requires re-verification before any send or release.
  reverify_required boolean NOT NULL DEFAULT false,
  reverify_reason text,
  -- C2-2: recovery imposes a 48-hour delay before any outgoing transfer.
  outgoing_locked_until timestamptz,
  sanctions_status text NOT NULL DEFAULT 'unscreened' CHECK (sanctions_status IN ('unscreened', 'clear', 'potential_match', 'confirmed_match')),
  sanctions_screened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_handle ON app.users (tenant_id, lower(handle)) WHERE handle IS NOT NULL;
CREATE UNIQUE INDEX users_email ON app.users (tenant_id, lower(email));
CREATE UNIQUE INDEX users_phone ON app.users (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL AND phone_verified_at IS NOT NULL;

-- C1-9: consent captured under the Nigeria Data Protection Act 2023.
CREATE TABLE app.consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  version text NOT NULL,
  text_sha256 text NOT NULL,
  purposes text[] NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  withdrawn_at timestamptz
);

-- C1-2..C1-5, C1-9: identity data encrypted at rest; lookup_hmac enforces one Tier 1 account per BVN/NIN.
CREATE TABLE app.identity_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  kind text NOT NULL CHECK (kind IN ('bvn', 'nin', 'cac', 'passport', 'national_id', 'drivers_licence', 'liveness', 'address')),
  lookup_hmac text,
  payload_enc bytea NOT NULL,
  vendor text NOT NULL,
  vendor_ref text,
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'failed')),
  failure_reason text,
  verified_at timestamptz,
  retain_until date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identity_one_account_per_id ON app.identity_records (tenant_id, kind, lookup_hmac)
  WHERE status = 'verified' AND kind IN ('bvn', 'nin');

CREATE TABLE app.businesses (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  tenant_id integer NOT NULL DEFAULT 1,
  company_name text NOT NULL,
  cac_number text NOT NULL,
  address text NOT NULL,
  verified_at timestamptz,
  second_approver_above_units numeric(78,0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX businesses_cac ON app.businesses (tenant_id, cac_number) WHERE verified_at IS NOT NULL;

CREATE TABLE app.business_members (
  business_id uuid NOT NULL REFERENCES app.users(id),
  member_id uuid NOT NULL REFERENCES app.users(id),
  role text NOT NULL CHECK (role IN ('director', 'approver', 'member')),
  tenant_id integer NOT NULL DEFAULT 1,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, member_id)
);

CREATE TABLE app.otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  destination text NOT NULL,
  purpose text NOT NULL,
  user_id uuid REFERENCES app.users(id),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE app.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app.users(id),
  purpose text NOT NULL,
  challenge text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE app.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  fingerprint text NOT NULL,
  label text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  trusted_at timestamptz,
  UNIQUE (user_id, fingerprint)
);

CREATE TABLE app.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  device_id uuid REFERENCES app.devices(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_passkey_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE app.recovery_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  method text NOT NULL CHECK (method IN ('second_passkey', 'provider_recovery')),
  status text NOT NULL CHECK (status IN ('started', 'identity_verified', 'completed', 'cancelled')),
  identity_reverified_at timestamptz,
  outgoing_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- ------------------------------------------------------------------ app: wallet (C2)

CREATE TABLE app.wallets (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  tenant_id integer NOT NULL DEFAULT 1,
  provider text NOT NULL,
  provider_wallet_id text NOT NULL,
  tron_address text,
  evm_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallets_tron ON app.wallets (tron_address) WHERE tron_address IS NOT NULL;
CREATE UNIQUE INDEX wallets_evm ON app.wallets (lower(evm_address)) WHERE evm_address IS NOT NULL;

CREATE TABLE app.rate_snapshots (
  id bigserial PRIMARY KEY,
  ngn_per_usd numeric(20,6) NOT NULL,
  source text NOT NULL,
  as_of timestamptz NOT NULL
);

-- Every movement the user sees in history (C2-9), inbound or outbound, internal or external.
CREATE TABLE app.transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  kind text NOT NULL DEFAULT 'transfer' CHECK (kind IN ('transfer', 'escrow_funding', 'escrow_payout', 'escrow_refund', 'fee', 'cctp')),
  network text NOT NULL,
  token text NOT NULL,
  token_contract text,
  amount_units numeric(78,0) NOT NULL CHECK (amount_units >= 0),
  fee_units numeric(78,0) NOT NULL DEFAULT 0,
  from_address text,
  to_address text,
  counterparty_user_id uuid REFERENCES app.users(id),
  counterparty_label text,
  status text NOT NULL CHECK (status IN ('prepared', 'submitted', 'confirmed', 'final', 'failed', 'dropped')),
  availability text NOT NULL DEFAULT 'pending' CHECK (availability IN ('pending', 'available', 'on_hold', 'under_review', 'unrecognised', 'dust_hidden', 'unsupported_pair')),
  hold_reason text,
  check_decision_id uuid,
  presend_decision_id uuid,
  tx_hash text,
  log_index integer,
  block_number bigint,
  idempotency_key text,
  signed_tx_sha256 text,
  note text,
  payment_request_id uuid,
  payment_id uuid,
  ngn_per_usd numeric(20,6),
  rate_source text,
  rate_as_of timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  final_at timestamptz
);
CREATE UNIQUE INDEX transfers_idem ON app.transfers (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX transfers_chain_event ON app.transfers (user_id, network, tx_hash, log_index, direction) WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL;
-- NFR Connectivity: a signed transaction is never broadcast twice.
CREATE UNIQUE INDEX transfers_signed_once ON app.transfers (signed_tx_sha256) WHERE signed_tx_sha256 IS NOT NULL;
CREATE INDEX transfers_user_time ON app.transfers (user_id, created_at DESC);

CREATE TABLE app.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  label text NOT NULL,
  recipient_user_id uuid REFERENCES app.users(id),
  address text,
  last_network text,
  last_token text,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_owner_target ON app.contacts (owner_id, coalesce(recipient_user_id::text, address));

CREATE TABLE app.payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  slug text NOT NULL UNIQUE,
  amount_units numeric(78,0) NOT NULL CHECK (amount_units > 0),
  token text NOT NULL,
  note text,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'cancelled')),
  paid_transfer_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  owner_user_id uuid REFERENCES app.users(id),
  owner_staff_id uuid,
  purpose text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  attached_to text,
  attached_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ app: protected payments (C4, L2-L4)

CREATE TABLE app.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  freelancer_id uuid NOT NULL REFERENCES app.users(id),
  client_email text NOT NULL,
  client_user_id uuid REFERENCES app.users(id),
  client_country char(2),
  description text NOT NULL,
  token text NOT NULL CHECK (token IN ('USDC', 'USDT')),
  total_units numeric(78,0) NOT NULL CHECK (total_units > 0),
  due_date timestamptz NOT NULL,
  fee_split boolean NOT NULL DEFAULT false,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'partially_funded', 'funded', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.trade_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  importer_id uuid NOT NULL REFERENCES app.users(id),
  supplier_email text NOT NULL,
  supplier_user_id uuid REFERENCES app.users(id),
  goods_description text NOT NULL,
  proforma_file_id uuid NOT NULL REFERENCES app.files(id),
  token text NOT NULL CHECK (token IN ('USDC', 'USDT')),
  total_units numeric(78,0) NOT NULL CHECK (total_units > 0),
  shipping_deadline timestamptz NOT NULL,
  split text NOT NULL CHECK (split IN ('single', 'deposit_balance')),
  deposit_units numeric(78,0),
  slug text NOT NULL UNIQUE,
  terms_sha256 text NOT NULL,
  supplier_accepted_at timestamptz,
  supplier_accept_ip inet,
  status text NOT NULL DEFAULT 'awaiting_supplier' CHECK (status IN ('awaiting_supplier', 'accepted', 'funded', 'shipped', 'completed', 'cancelled')),
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per escrow (milestone, deposit, balance or P2P trade). `created`/`cancelled` are off-chain only.
CREATE TABLE app.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  loop text NOT NULL CHECK (loop IN ('L2', 'L3', 'L4')),
  invoice_id uuid REFERENCES app.invoices(id),
  order_id uuid REFERENCES app.trade_orders(id),
  trade_id uuid,
  part_index integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  payer_user_id uuid REFERENCES app.users(id),
  payee_user_id uuid NOT NULL REFERENCES app.users(id),
  payer_address text,
  payee_address text NOT NULL,
  refund_address text,
  network text,
  token text NOT NULL,
  amount_units numeric(78,0) NOT NULL CHECK (amount_units > 0),
  fee_bps integer NOT NULL,
  fee_units numeric(78,0) NOT NULL,
  fee_schedule_version text NOT NULL,
  deliver_by timestamptz NOT NULL,
  hold_period_seconds integer NOT NULL,
  auto_release boolean NOT NULL,
  arbiter_timeout_seconds integer NOT NULL,
  order_ref text NOT NULL UNIQUE,
  escrow_address text,
  factory_address text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'cancelled', 'funded', 'delivered', 'disputed', 'released', 'refunded')),
  funding_deadline timestamptz NOT NULL,
  funded_at timestamptz,
  funded_tx text,
  delivered_at timestamptz,
  hold_until timestamptz,
  disputed_at timestamptz,
  released_at timestamptz,
  refunded_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  fee_owed_units numeric(78,0) NOT NULL DEFAULT 0,
  fee_collected boolean NOT NULL DEFAULT false,
  last_ruling_hash text,
  release_paused_reason text,
  issuer_frozen_at timestamptz,
  payee_frozen boolean NOT NULL DEFAULT false,
  approval_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_status ON app.payments (status);
CREATE UNIQUE INDEX payments_escrow ON app.payments (lower(escrow_address)) WHERE escrow_address IS NOT NULL;

CREATE TABLE app.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  payment_id uuid NOT NULL REFERENCES app.payments(id),
  submitted_by uuid NOT NULL REFERENCES app.users(id),
  note text,
  links text[] NOT NULL DEFAULT '{}',
  file_ids uuid[] NOT NULL DEFAULT '{}',
  tracking_number text,
  carrier text,
  tracking_validation text CHECK (tracking_validation IN ('valid', 'mismatch', 'unsupported', 'pending')),
  evidence_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- L3-7: business second approver for funding and release above a set amount.
CREATE TABLE app.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  business_id uuid NOT NULL REFERENCES app.users(id),
  payment_id uuid NOT NULL REFERENCES app.payments(id),
  action text NOT NULL CHECK (action IN ('fund', 'release')),
  requested_by uuid NOT NULL REFERENCES app.users(id),
  approved_by uuid REFERENCES app.users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

-- ------------------------------------------------------------------ app: P2P (L4)

CREATE TABLE app.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  bank_code text NOT NULL,
  bank_name text NOT NULL,
  account_number_enc bytea NOT NULL,
  account_number_hmac text NOT NULL,
  account_last4 text NOT NULL,
  account_name text NOT NULL,
  name_match text NOT NULL,
  verified_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bank_accounts_unique ON app.bank_accounts (tenant_id, account_number_hmac, bank_code) WHERE removed_at IS NULL;

CREATE TABLE app.p2p_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  merchant_id uuid NOT NULL REFERENCES app.users(id),
  side text NOT NULL CHECK (side IN ('sell', 'buy')),
  price_ngn numeric(20,2) NOT NULL CHECK (price_ngn > 0),
  min_units numeric(78,0) NOT NULL,
  max_units numeric(78,0) NOT NULL,
  payment_window_seconds integer NOT NULL,
  fee_bps integer NOT NULL,
  bank_account_id uuid REFERENCES app.bank_accounts(id),
  terms text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_units > 0 AND max_units >= min_units)
);

CREATE TABLE app.p2p_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  offer_id uuid NOT NULL REFERENCES app.p2p_offers(id),
  seller_id uuid NOT NULL REFERENCES app.users(id),
  buyer_id uuid NOT NULL REFERENCES app.users(id),
  amount_units numeric(78,0) NOT NULL,
  price_ngn numeric(20,2) NOT NULL,
  naira_kobo numeric(30,0) NOT NULL,
  seller_bank_account_id uuid NOT NULL REFERENCES app.bank_accounts(id),
  buyer_bank_account_id uuid NOT NULL REFERENCES app.bank_accounts(id),
  payment_id uuid REFERENCES app.payments(id),
  status text NOT NULL DEFAULT 'awaiting_escrow' CHECK (status IN ('awaiting_escrow', 'escrowed', 'paid', 'released', 'cancelled', 'disputed', 'refunded')),
  payment_deadline timestamptz,
  marked_paid_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.payments ADD CONSTRAINT payments_trade_fk FOREIGN KEY (trade_id) REFERENCES app.p2p_trades(id);

CREATE TABLE app.trade_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  trade_id uuid NOT NULL REFERENCES app.p2p_trades(id),
  sender_id uuid REFERENCES app.users(id),
  body text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  blocked_kinds text[] NOT NULL DEFAULT '{}',
  system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ app: notifications, support

CREATE TABLE app.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid REFERENCES app.users(id),
  email text,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE TABLE app.push_tokens (
  user_id uuid NOT NULL REFERENCES app.users(id),
  token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);

CREATE TABLE app.support_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  user_id uuid NOT NULL REFERENCES app.users(id),
  subject text NOT NULL,
  payment_id uuid REFERENCES app.payments(id),
  transfer_id uuid REFERENCES app.transfers(id),
  funds_involved boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  first_response_due timestamptz,
  first_response_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES app.support_threads(id),
  author_user_id uuid REFERENCES app.users(id),
  author_staff_id uuid,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ network: fraud list, checks, disputes (C3, C4, C5)

CREATE TABLE network.list_versions (
  version bigserial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  change text NOT NULL,
  listing_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO network.list_versions (change) VALUES ('initial');

-- Labelled exchange hot wallets, bridges, token contracts and known services. Tracing stops here and
-- these can never be listed (C5-5). `accepts` lists the network:token pairs the service accepts.
CREATE TABLE network.labelled_addresses (
  address_key text PRIMARY KEY,
  address text NOT NULL,
  family text NOT NULL CHECK (family IN ('evm', 'tron')),
  kind text NOT NULL CHECK (kind IN ('exchange', 'bridge', 'token_contract', 'service')),
  name text NOT NULL,
  accepts text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE network.listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  address_key text NOT NULL,
  address text NOT NULL,
  family text NOT NULL CHECK (family IN ('evm', 'tron')),
  status text NOT NULL CHECK (status IN ('reported', 'confirmed', 'rejected', 'under_appeal', 'delisted', 'expired')),
  -- status before an appeal opened, restored if the appeal is upheld
  status_before_appeal text,
  label text NOT NULL CHECK (label IN ('fraud', 'sanctions', 'issuer_frozen', 'scam_report')),
  source text NOT NULL CHECK (source IN ('dispute_ruling', 'user_report', 'sanctions', 'issuer_freeze', 'public_scam_site', 'p2p_naira_fraud')),
  case_id uuid,
  source_ref text,
  confirmed_by uuid,
  second_confirmed_by uuid,
  confirmed_at timestamptz,
  expires_at timestamptz,
  renewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX listings_active ON network.listings (tenant_id, address_key, label)
  WHERE status IN ('reported', 'confirmed', 'under_appeal');
CREATE INDEX listings_key ON network.listings (address_key);

CREATE TABLE network.fraud_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  reporter_user_id uuid,
  reporter_identity_checked boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('user', 'law_enforcement', 'public_scam_site', 'dispute_ruling', 'p2p')),
  law_enforcement_ref text,
  case_type text NOT NULL CHECK (case_type IN ('scam', 'impersonation', 'non_delivery', 'stolen_funds', 'third_party_naira', 'phishing', 'other')),
  tx_hashes text[] NOT NULL DEFAULT '{}',
  suspect_addresses text[] NOT NULL,
  network text,
  amount_units numeric(78,0),
  statement text NOT NULL,
  file_ids uuid[] NOT NULL DEFAULT '{}',
  related_transfer_id uuid,
  related_payment_id uuid,
  related_trade_id uuid,
  case_id uuid,
  complete_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE network.fraud_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  address_key text NOT NULL,
  address text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awaiting_second', 'confirmed', 'rejected')),
  amount_units numeric(78,0),
  analyst_id uuid,
  second_analyst_id uuid,
  decision_code text,
  decision_reason text,
  traced_path jsonb,
  due_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE network.ownership_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  nonce text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE network.appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  public_ref text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('listing', 'hold')),
  listing_id uuid REFERENCES network.listings(id),
  transfer_id uuid,
  address text,
  address_key text,
  appellant_user_id uuid,
  appellant_email text,
  ownership_challenge_id uuid REFERENCES network.ownership_challenges(id),
  ownership_signature text,
  ownership_verified_at timestamptz,
  statement text NOT NULL,
  file_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'granted', 'upheld')),
  reporter_notified_at timestamptz,
  reporter_evidence_due timestamptz,
  reporter_file_ids uuid[] NOT NULL DEFAULT '{}',
  reporter_statement text,
  analyst_id uuid,
  decision_reason text,
  due_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- C3-6: every decision stores its inputs, list version and rule version for replay.
CREATE TABLE network.check_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('presend', 'inbound')),
  user_id uuid,
  subject text NOT NULL,
  inputs jsonb NOT NULL,
  decision text NOT NULL,
  reasons jsonb NOT NULL,
  list_version bigint NOT NULL,
  rule_version text NOT NULL,
  degraded boolean NOT NULL DEFAULT false,
  latency_ms integer NOT NULL,
  overridden_at timestamptz,
  override_ack jsonb,
  supersedes uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- C3-5: inbound `review` goes to a risk analyst who clears or holds within 1 business day.
CREATE TABLE network.review_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('inbound', 'payee_listed_during_hold', 'rescreen_change', 'keeper_failure', 'issuer_freeze_escrow', 'p2p_naira_fraud')),
  transfer_id uuid,
  payment_id uuid,
  user_id uuid,
  decision_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'held', 'resolved')),
  analyst_id uuid,
  resolution_reason text,
  due_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE network.disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  payment_id uuid NOT NULL,
  loop text NOT NULL,
  opened_by_role text NOT NULL CHECK (opened_by_role IN ('payer', 'payee')),
  opened_by_user uuid,
  reason text NOT NULL,
  evidence_due_at timestamptz NOT NULL,
  ruling_due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'evidence' CHECK (status IN ('evidence', 'in_review', 'ruled', 'awaiting_signatures', 'executed', 'closed')),
  reviewer_id uuid,
  ruling text CHECK (ruling IN ('release', 'refund')),
  ruling_reason text,
  ruling_hash text,
  fraud_found boolean NOT NULL DEFAULT false,
  fraud_party text CHECK (fraud_party IN ('payer', 'payee')),
  ruled_at timestamptz,
  second_review_requested_by uuid,
  second_review_requested_at timestamptz,
  second_reviewer_id uuid,
  final_ruling text CHECK (final_ruling IN ('release', 'refund')),
  final_reason text,
  executed_tx text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX disputes_one_open ON network.disputes (payment_id) WHERE status NOT IN ('executed', 'closed');

CREATE TABLE network.dispute_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES network.disputes(id),
  party text NOT NULL CHECK (party IN ('payer', 'payee', 'system')),
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('file', 'link', 'statement', 'delivery', 'chat_log', 'bank_evidence', 'inspection_report')),
  file_id uuid,
  url text,
  body text,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- C4-4 / NFR Security: arbiter is 2-of-3; each signer approval recorded before execution.
CREATE TABLE network.arbiter_approvals (
  dispute_id uuid NOT NULL REFERENCES network.disputes(id),
  ruling_hash text NOT NULL,
  ruling text NOT NULL,
  staff_id uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispute_id, ruling_hash, staff_id)
);

-- Address exposure graph for inbound tracing: token transfers fetched per traced address.
CREATE TABLE network.chain_transfers (
  network text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  token_contract text NOT NULL,
  from_key text NOT NULL,
  to_key text NOT NULL,
  amount_units numeric(78,0) NOT NULL,
  block_number bigint NOT NULL,
  block_time timestamptz NOT NULL,
  PRIMARY KEY (network, tx_hash, log_index)
);
CREATE INDEX chain_transfers_to ON network.chain_transfers (to_key, block_time);

-- ------------------------------------------------------------------ staff

CREATE TABLE app.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id integer NOT NULL DEFAULT 1,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  roles text[] NOT NULL,
  sso_subject text UNIQUE,
  totp_secret_enc bytea,
  mfa_enrolled_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (roles <@ ARRAY['dispute_reviewer', 'risk_analyst', 'arbiter_signer', 'support', 'admin']::text[])
);

CREATE TABLE app.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES app.staff(id),
  token_hash text NOT NULL UNIQUE,
  mfa_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE app.sso_states (
  state text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);

-- ------------------------------------------------------------------ ops: durable queue, indexer cursors

CREATE TABLE ops.jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  locked_until timestamptz,
  locked_by text,
  done_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON ops.jobs (run_at) WHERE done_at IS NULL AND failed_at IS NULL;

CREATE TABLE ops.indexer_cursors (
  network text NOT NULL,
  stream text NOT NULL,
  last_block bigint NOT NULL,
  head_block bigint,
  head_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, stream)
);

CREATE TABLE ops.outbox (
  id bigserial PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'push')),
  destination text NOT NULL,
  subject text,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  provider text NOT NULL,
  provider_ref text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- ------------------------------------------------------------------ audit (append-only)

CREATE TABLE audit.events (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL DEFAULT 1,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'staff', 'system', 'public', 'keeper', 'indexer')),
  actor_id text,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text,
  data jsonb NOT NULL DEFAULT '{}',
  prev_hash text,
  hash text NOT NULL
);

CREATE FUNCTION audit.chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(733101);
  SELECT hash INTO prev FROM audit.events ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := encode(digest(coalesce(prev, '') || NEW.tenant_id::text || NEW.at::text || NEW.actor_type ||
    coalesce(NEW.actor_id, '') || NEW.action || NEW.subject_type || coalesce(NEW.subject_id, '') || NEW.data::text, 'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_chain BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.chain();

CREATE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.events is append-only';
END $$;

CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit.events FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();

-- check decisions are part of the audit record too: never updated except to record an override.
CREATE FUNCTION network.decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'check decisions are append-only'; END IF;
  IF NEW.inputs IS DISTINCT FROM OLD.inputs OR NEW.decision IS DISTINCT FROM OLD.decision OR NEW.reasons IS DISTINCT FROM OLD.reasons
     OR NEW.list_version IS DISTINCT FROM OLD.list_version OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
     OR (OLD.overridden_at IS NOT NULL) THEN
    RAISE EXCEPTION 'check decisions are append-only (only a single override may be recorded)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_guard BEFORE UPDATE OR DELETE ON network.check_decisions FOR EACH ROW EXECUTE FUNCTION network.decision_guard();
