# API reference

See [the README](../README.md) for setup and the quick walkthrough.

### See wallets and balances

```http
GET /wallets
```

Returns an array ordered by wallet index. Each item includes:

- `index` and `address`: which wallet this is.
- `balance`: ETH as a decimal string.
- `balanceWei`: the same amount as an exact integer string.
- `checkedAt`: when the balance was last read, in UTC.
- `blockNumber` and `blockHash`: the block used for that reading.
- `stale`: true before the first reading or after 10 minutes without an update.

Balances and observation details are `null` until the first successful poll.
This endpoint reads saved balances, so it still works during an RPC outage.

### See balance history

```http
GET /wallets/0/history?limit=50
```

Returns `{ items, nextCursor }`, newest first. To get the next page, pass
`nextCursor` as `before`. The maximum page size is 100.

History entries use amounts in wei and have three kinds:

- `BASELINE`: the first reading, including any funds already there.
- `INFLOW`: the balance increased since the previous reading.
- `DECREASE`: the balance decreased since the previous reading.

### Build or send a withdrawal

```http
POST /withdrawals
Authorization: Bearer <WITHDRAWAL_API_KEY>
Content-Type: application/json
```

```json
{
  "walletIndex": 0,
  "to": "<DESTINATION_ADDRESS>",
  "amount": "0.00001",
  "broadcast": false
}
```

Replace the destination with an Ethereum address. `amount` is an ETH **string**,
with up to 18 decimal places. The wallet needs enough ETH for the amount and
the maximum gas fee, even when only signing. The app chooses nonce and fees.

With `broadcast: false` (the default), the response contains the transaction
`payload`, wallet `signature`, serialized `unsignedTransaction` and
`signedTransaction`, `transactionHash`, and `maxFeeWei`.
It returns `status: SIGNED` and `withdrawalId: null`, without recording an
outflow. The signed bytes are usable: someone holding them can send the
transaction.
Signing alone does not reserve a nonce or balance.

To send, set `broadcast: true` and add a unique request key:

```http
Idempotency-Key: demo-withdrawal-001
```

Keep this key and reuse it with the same body if the request fails or times out.
The app saves the signed transaction before sending, so retries use the same
bytes, including after a restart. Reusing a key with different transfer details
returns HTTP 409. Keys must be 8-128 characters: letters, digits, `.`, `_`,
`:`, or `-`.

The response tells you what happened:

- **200 / SIGNED**: built and signed; not sent by the service.
- **201 / BROADCAST**: RPC accepted the transaction, or found it by its hash.
  One `OUTFLOW` is saved. Repeating the request returns the saved result.
- **202 / UNCERTAIN**: the app could not establish whether RPC accepted it.
  No outflow is saved yet. Retry with the same key and body.

`BROADCAST` does not mean mined or successful. `maxFeeWei` is the fee ceiling,
not the actual fee. Other responses include 400 for invalid input, 401 for a
missing or invalid API key, 404 for an inactive wallet, 409 for conflicts,
413 for an oversized body, 422 for insufficient funds or an invalid transfer,
and 503 for an RPC or database failure.

`GET /health` returns `{"status":"ok"}` while the HTTP server is running.
It does not check the database or RPC.
