-- Sandbox demo accounts: created by "Launch App" without sign-up, never in production. Flagged so
-- staff, audits and clean-up can tell them apart from real customers.
ALTER TABLE app.users ADD COLUMN demo boolean NOT NULL DEFAULT false;
