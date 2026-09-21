CREATE TABLE withdrawals (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  wallet_index integer NOT NULL REFERENCES wallets(wallet_index),
  nonce bigint NOT NULL CHECK (nonce >= 0 AND nonce <= 9007199254740991),
  destination text NOT NULL CHECK (destination ~ '^0x[0-9a-fA-F]{40}$'),
  amount_wei numeric(78, 0) NOT NULL CHECK (amount_wei > 0),
  tx_hash text NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  signed_transaction text NOT NULL CHECK (signed_transaction ~ '^0x02[0-9a-f]+$'),
  status text NOT NULL CHECK (status IN ('PREPARED', 'UNCERTAIN', 'BROADCAST')),
  created_at timestamptz NOT NULL DEFAULT now(),
  broadcast_at timestamptz,
  UNIQUE (wallet_index, nonce),
  CHECK ((status = 'BROADCAST' AND broadcast_at IS NOT NULL)
    OR (status IN ('PREPARED', 'UNCERTAIN') AND broadcast_at IS NULL))
);

CREATE TABLE outflows (
  withdrawal_id uuid PRIMARY KEY REFERENCES withdrawals(id),
  wallet_index integer NOT NULL REFERENCES wallets(wallet_index),
  event_type text NOT NULL DEFAULT 'OUTFLOW' CHECK (event_type = 'OUTFLOW'),
  tx_hash text NOT NULL UNIQUE,
  amount_wei numeric(78, 0) NOT NULL CHECK (amount_wei > 0),
  destination text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX withdrawals_wallet_status ON withdrawals (wallet_index, status);
