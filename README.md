# Wallet Watcher

A small custody backend for **Sepolia ETH**, built with Node.js, TypeScript,
Express, ethers v6, and PostgreSQL.

It creates wallets, tracks their balances, and signs or sends withdrawals.

## 1. Start the service

Install **Node.js 22.15+** and start **Docker with Compose**.
Open a terminal in this project directory and run these commands in order:

```sh
npm ci
npm run setup
npm run db:up
npm run dev
```

Leave this terminal open. The API runs at **http://127.0.0.1:3000**.
Setup creates `.env` with test wallets, a database password, and an API key.
Existing settings are preserved. Database migrations run automatically.

All commands below work in PowerShell, Bash, or zsh. Run them from the project
folder in a **second terminal**. If a command fails, fix that error before
moving on.

## 2. Run the automated tests

```sh
npm run check
npm run test:integration
```

Both commands should pass. They check wallet generation, transaction fields
and signatures, balances, API errors, and duplicate withdrawal handling.
Tests use no test funds and never broadcast. Database tests use their own
isolated schema, leaving application data intact.

## 3. See wallets and fund one

```sh
npm run demo
```

This prints wallet addresses, balances, and recent balance changes. Wait until
wallet 0 has a balance reading, then send **0.001 Sepolia ETH** to the funding
address printed by the command. Use your test wallet or a faucet.

Wait for the deposit to be mined, then allow about a minute for polling.
Run `npm run demo` again: wallet 0 should show the funds and an `INFLOW` entry.
You can also open http://127.0.0.1:3000/wallets in your browser.

## 4. Sign without sending

```sh
npm run demo:sign
```

This builds a transfer of **0.00001 ETH** from wallet 0 to wallet 1 through
`POST /withdrawals`. It prints the JSON payload and signature, checks the
signer, and confirms no withdrawal or outflow was saved. Expected: **PASS**.
No transfer is sent. The wallet still needs enough ETH to cover gas.

## 5. Send and retry

**The next command sends 0.00001 Sepolia ETH from wallet 0 to wallet 1:**

```sh
npm run demo:send
```

Expected: **PASS**, exactly one saved outflow, and an explorer link.
Open the link and wait for **Success**. Then run `npm run demo` to see the
updated balances: wallet 0 pays the transfer plus gas; wallet 1 receives it.

Now stop the server in the first terminal with **Ctrl+C**, then restart it:

```sh
npm run dev
```

In the second terminal, run:

```sh
npm run demo:retry
npm run demo
```

Expected: **PASS** with the same transaction hash and no duplicate records.
Wallet addresses and history should still be there.

The demo saves its request and result in `data/`, so retries also work in a
new terminal. Repeating `demo:send` reuses the same request. Keep these files
if sending fails or times out; run `demo:retry` to resume that attempt.

## If something fails

- **Insufficient funds:** top up wallet 0 with Sepolia ETH. Gas costs extra,
  including when only signing. Then repeat the failed command.
- **API unavailable:** check that `npm run dev` is still running.
- **Uncertain broadcast:** run `npm run demo:retry` with the saved request.
- **Windows EPERM during npm ci:** stop the dev server before reinstalling.

## API and settings

The demo commands call the real HTTP API and check results in PostgreSQL.
They read the API key from `.env`; no key copying or shell variables are needed.

- `GET /wallets`: all active addresses and saved balances.
- `GET /wallets/0/history`: wallet 0's balance history.
- `POST /withdrawals`: build/sign, or send with `broadcast: true`.
- `GET /health`: confirms the HTTP server is running.

Request bodies, authentication, and responses: [API reference](docs/api.md).

To change settings, edit `.env` and restart the server. `WALLET_COUNT` accepts
1 to 20 (default 5); `RPC_URL` selects a Sepolia HTTP endpoint. Other settings
are listed in [.env.example](.env.example). The demo needs at least two wallets.
Keep the same seed phrase to keep the same addresses. Try changing the count
from 5 to 2 and back: the original addresses and history are preserved.

## Deposit handling and tradeoffs

Balances are polled roughly once a minute and saved in PostgreSQL. The first
reading is a `BASELINE`. Later increases are `INFLOW`; decreases are `DECREASE`.
Two deposits between polls appear as one net increase. After downtime, the
first poll compares the current balance with the last saved one. Individual
transactions are not reconstructed; opposite transfers can cancel each other
out. An RPC outage keeps the old balances, marked stale after 10 minutes.
Startup requires a working database and RPC connection.

`OUTFLOW` is recorded separately only after broadcast is observed, never for
signing alone. It excludes gas and does not prove mining or execution success.
Do not add outflows to balance changes: they describe the same money movement.

Balances use the latest block without waiting for confirmations, so a reorg
can cause later corrections. History is not rewritten. Run one app instance.
Each wallet allows one unconfirmed broadcast; there is no confirmation tracker,
automatic retry worker, fee bumping, or cancellation. Unresolved transactions
may need manual investigation. A healthy RPC is needed for timely updates;
`stale` does not indicate whether that node is synchronized.

Sepolia only: network and signing chain IDs are checked. Use test funds and
keys. `.env` and `data/` are ignored by Git. Private keys are neither returned
by the API nor stored in PostgreSQL. Remote access needs HTTPS; authentication
uses one shared API key.
