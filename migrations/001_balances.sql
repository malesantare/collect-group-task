CREATE TABLE wallets (
  wallet_index integer PRIMARY KEY CHECK (wallet_index BETWEEN 0 AND 19),
  chain_id integer NOT NULL DEFAULT 11155111 CHECK (chain_id = 11155111),
  address text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  balance_wei numeric(78, 0) CHECK (balance_wei >= 0),
  block_number bigint CHECK (block_number >= 0),
  block_hash text CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((balance_wei IS NULL AND block_number IS NULL AND block_hash IS NULL AND checked_at IS NULL)
    OR (balance_wei IS NOT NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL AND checked_at IS NOT NULL))
);

CREATE TABLE balance_changes (
  id bigserial PRIMARY KEY,
  wallet_index integer NOT NULL REFERENCES wallets(wallet_index),
  kind text NOT NULL CHECK (kind IN ('BASELINE', 'INFLOW', 'DECREASE')),
  old_balance_wei numeric(78, 0) CHECK (old_balance_wei >= 0),
  new_balance_wei numeric(78, 0) NOT NULL CHECK (new_balance_wei >= 0),
  delta_wei numeric(79, 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  observed_at timestamptz NOT NULL,
  CHECK (
    (kind = 'BASELINE' AND old_balance_wei IS NULL AND delta_wei IS NULL)
    OR (kind = 'INFLOW' AND old_balance_wei IS NOT NULL AND delta_wei IS NOT NULL
      AND delta_wei > 0 AND new_balance_wei - old_balance_wei = delta_wei)
    OR (kind = 'DECREASE' AND old_balance_wei IS NOT NULL AND delta_wei IS NOT NULL
      AND delta_wei < 0 AND new_balance_wei - old_balance_wei = delta_wei)
  )
);

CREATE INDEX balance_changes_wallet_id ON balance_changes (wallet_index, id DESC);
