import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgBalanceStore, WalletIdentityError } from '../../src/db/balance-store.js';
import { generateWallets } from '../../src/blockchain/wallets.js';
import type { BalanceSnapshot } from '../../src/balances/types.js';
import { createApp } from '../../src/app.js';
import { TEST_MNEMONIC } from '../fixtures/mnemonic.js';
import { Transaction } from 'ethers';
import { HdTransactionSigner } from '../../src/blockchain/transaction.js';
import { PgWithdrawalStore } from '../../src/db/withdrawal-store.js';
import { WithdrawalService } from '../../src/withdrawals/service.js';
import { fakeGateway } from '../fixtures/withdrawal.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL integration tests.');
const schema = `ww_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
const poolConfig = { connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 };
const pool = new Pool(poolConfig);
const store = new PgBalanceStore(pool);
const wallets = generateWallets(TEST_MNEMONIC, 5);
let schemaCreated = false;

function snapshot(value: bigint, height = 100, count = 1): BalanceSnapshot {
  return {
    blockNumber: height,
    blockHash: `0x${height.toString(16).padStart(64, '0')}`,
    observedAt: new Date(Date.UTC(2000, 0, 1, 0, 0, height)),
    balances: wallets.slice(0, count).map((wallet) => ({ ...wallet, balanceWei: value })),
  };
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const result = await pool.query<{ current_schema: string }>('SELECT current_schema()');
  if (result.rows[0]?.current_schema !== schema) throw new Error('Integration database isolation failed.');
  await migrate(pool);
});

describe('withdrawal persistence and API', () => {
  const input = { walletIndex: 0, to: wallets[1]!.address, amount: '0.01', broadcast: true };
  function service(gateway = fakeGateway(), connection = pool) {
    return new WithdrawalService(wallets, new HdTransactionSigner(TEST_MNEMONIC, wallets.length), gateway, new PgWithdrawalStore(connection));
  }
  async function rowCounts() {
    const result = await pool.query(`SELECT (SELECT count(*)::integer FROM withdrawals) AS withdrawals,
      (SELECT count(*)::integer FROM outflows) AS outflows`);
    return result.rows[0];
  }

  it('creates no withdrawal or outflow when only signing', async () => {
    await store.registerWallets(wallets);
    const result = await service().withdraw({ ...input, broadcast: false });
    expect(result.status).toBe('SIGNED');
    expect(Transaction.from(result.signedTransaction).from).toBe(wallets[0]?.address);
    expect(await rowCounts()).toEqual({ withdrawals: 0, outflows: 0 });
  });

  it('persists exactly one outflow after broadcast and idempotent replay', async () => {
    await store.registerWallets(wallets);
    const gateway = fakeGateway();
    const app = service(gateway);
    const first = await app.withdraw(input, 'integration-withdrawal-001');
    const second = await app.withdraw(input, 'integration-withdrawal-001');
    expect(second).toEqual(first);
    expect(gateway.send).toHaveBeenCalledTimes(1);
    expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 1 });
    const result = await pool.query('SELECT event_type, tx_hash, amount_wei, destination FROM outflows');
    expect(result.rows[0]).toMatchObject({ event_type: 'OUTFLOW', tx_hash: first.transactionHash,
      amount_wei: '10000000000000000', destination: wallets[1]?.address });
    expect(await store.history(0, 10)).toHaveLength(0);
    expect((await store.listWallets(5))[0]?.balanceWei).toBeNull();
  });

  it('recovers uncertain broadcasts after reconnecting without rebuilding or changing signed bytes', async () => {
    await store.registerWallets(wallets);
    const gateway = fakeGateway();
    gateway.send.mockRejectedValue(new Error('RPC timeout'));
    const first = await service(gateway).withdraw(input, 'integration-withdrawal-001');
    expect(first.status).toBe('UNCERTAIN');
    expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 0 });
    const reconnected = new Pool(poolConfig);
    try {
      const recoveredGateway = fakeGateway();
      const second = await service(recoveredGateway, reconnected).withdraw(input, 'integration-withdrawal-001');
      expect(second.status).toBe('BROADCAST');
      expect(second.signedTransaction).toBe(first.signedTransaction);
      expect(recoveredGateway.quote).not.toHaveBeenCalled();
      expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 1 });
    } finally { await reconnected.end(); }
  });

  it('rolls back the broadcast state when insertion of the outflow fails', async () => {
    await store.registerWallets(wallets);
    await pool.query('ALTER TABLE outflows ADD CONSTRAINT test_reject_outflow CHECK (false)');
    const app = service();
    try {
      await expect(app.withdraw(input, 'integration-withdrawal-001')).rejects.toThrow();
      expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 0 });
      const saved = await pool.query('SELECT status FROM withdrawals');
      expect(saved.rows[0].status).toBe('UNCERTAIN');
    } finally { await pool.query('ALTER TABLE outflows DROP CONSTRAINT test_reject_outflow'); }
    expect((await app.withdraw(input, 'integration-withdrawal-001')).status).toBe('BROADCAST');
    expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 1 });
  });

  it('rejects competing requests for the same wallet while a send is in progress', async () => {
    await store.registerWallets(wallets);
    const gateway = fakeGateway();
    let notify!: () => void;
    let finish!: () => void;
    const sending = new Promise<void>((resolve) => { notify = resolve; });
    gateway.send.mockImplementation((raw) => new Promise<string>((resolve) => {
      finish = () => resolve(Transaction.from(raw).hash!);
      notify();
    }));
    const first = service(gateway).withdraw(input, 'integration-withdrawal-001');
    await sending;
    try {
      await expect(service().withdraw(input, 'integration-withdrawal-002')).rejects.toMatchObject({ code: 'WALLET_BUSY' });
    } finally { finish(); }
    await first;
    expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 1 });
  });

  it('exposes authenticated signing, broadcast, validation errors, and uncertain status via HTTP', async () => {
    await store.registerWallets(wallets);
    const gateway = fakeGateway();
    const apiKey = 'a'.repeat(64);
    const server: Server = await new Promise((resolve, reject) => {
      const listener = createApp(store, 5, { service: service(gateway), apiKey })
        .listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/withdrawals`;
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    try {
      expect((await fetch(url, { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
      expect(gateway.quote).not.toHaveBeenCalled();
      const bad = await fetch(url, { method: 'POST', headers, body: '{secret invalid json' });
      expect(bad.status).toBe(400);
      expect(await bad.text()).not.toContain('secret');
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, amount: 0.01 }) })).status).toBe(400);
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(400);
      const signed = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, broadcast: false }) });
      expect(signed.status).toBe(200);
      expect(signed.headers.get('cache-control')).toBe('no-store');
      const payload = await signed.json() as { status: string; signedTransaction: string };
      expect(payload.status).toBe('SIGNED');
      expect(Transaction.from(payload.signedTransaction).from).toBe(wallets[0]?.address);
      expect(await rowCounts()).toEqual({ withdrawals: 0, outflows: 0 });
      gateway.send.mockRejectedValueOnce(new Error('RPC timeout'));
      const broadcastHeaders = { ...headers, 'Idempotency-Key': 'integration-http-001' };
      expect((await fetch(url, { method: 'POST', headers: broadcastHeaders, body: JSON.stringify(input) })).status).toBe(202);
      expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 0 });
      expect((await fetch(url, { method: 'POST', headers: broadcastHeaders, body: JSON.stringify(input) })).status).toBe(201);
      expect(await rowCounts()).toEqual({ withdrawals: 1, outflows: 1 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
beforeEach(async () => {
  await pool.query('TRUNCATE TABLE outflows, withdrawals, balance_changes, wallets RESTART IDENTITY');
});
afterAll(async () => {
  await pool.end();
  // Drop only the isolated schema generated by this test run, never public data.
  if (schemaCreated && /^ww_test_[0-9a-f]{32}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

describe('PostgreSQL balance persistence', () => {
  it('applies migrations idempotently', async () => {
    await migrate(pool);
    const result = await pool.query('SELECT count(*)::integer AS count FROM schema_migrations');
    expect(result.rows[0].count).toBe(2);
  });

  it('keeps exact balances and history across new database connections', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(100000000000000001n));
    await store.applySnapshot(snapshot(100000000000000002n, 101));
    const reconnected = new Pool(poolConfig);
    try {
      const restored = new PgBalanceStore(reconnected);
      expect((await restored.listWallets(5))[0]?.balanceWei).toBe('100000000000000002');
      const history = await restored.history(0, 10);
      expect(history.map((change) => change.kind)).toEqual(['INFLOW', 'BASELINE']);
      expect(history[0]?.deltaWei).toBe('1');
    } finally { await reconnected.end(); }
  });

  it('orders history numerically across ID digit boundaries and paginates without gaps', async () => {
    await store.registerWallets(wallets);
    for (let i = 1; i <= 12; i++) {
      await store.applySnapshot(snapshot(BigInt(i), 100 + i));
    }
    const first = await store.history(0, 3);
    expect(first.map((change) => change.id)).toEqual(['12', '11', '10']);
    const second = await store.history(0, 10, first.at(-1)!.id);
    expect(second.map((change) => change.id)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1']);
  });

  it('does not duplicate history on concurrent identical observations', async () => {
    await store.registerWallets(wallets);
    const observation = snapshot(123n);
    const results = await Promise.all([store.applySnapshot(observation), store.applySnapshot(observation)]);
    expect(results.reduce((total, result) => total + result.changes, 0)).toBe(1);
    expect(await store.history(0, 10)).toHaveLength(1);
  });

  it('updates last-check metadata without creating changes for an unchanged balance', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(123n));
    expect(await store.applySnapshot(snapshot(123n, 101))).toEqual({ updated: 1, changes: 0 });
    expect((await store.listWallets(5))[0]?.blockNumber).toBe(101);
    expect(await store.history(0, 10)).toHaveLength(1);
  });

  it('records a balance decrease without inventing an OUTFLOW broadcast', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(123n));
    await store.applySnapshot(snapshot(100n, 101));
    const history = await store.history(0, 10);
    expect(history[0]).toMatchObject({ kind: 'DECREASE', deltaWei: '-23' });
  });

  it('rolls back both history and balances if any wallet update fails', async () => {
    await store.registerWallets(wallets.slice(0, 1));
    await expect(store.applySnapshot(snapshot(123n, 100, 2))).rejects.toBeInstanceOf(WalletIdentityError);
    expect((await store.listWallets(1))[0]?.balanceWei).toBeNull();
    expect(await store.history(0, 10)).toHaveLength(0);
  });

  it('preserves inactive wallets and their history through N = 5 -> 2 -> 5', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(123n, 100, 5));
    await store.registerWallets(wallets.slice(0, 2));
    expect(await store.listWallets(2)).toHaveLength(2);
    await store.registerWallets(wallets);
    expect((await store.listWallets(5))[4]?.balanceWei).toBe('123');
    expect(await store.history(4, 10)).toHaveLength(1);
  });

  it('rejects a different wallet identity without changing saved addresses', async () => {
    await store.registerWallets(wallets);
    const changed = [...wallets];
    changed[0] = { index: 0, address: '0x0000000000000000000000000000000000000001' };
    await expect(store.registerWallets(changed)).rejects.toBeInstanceOf(WalletIdentityError);
    expect((await store.listWallets(5))[0]?.address).toBe(wallets[0]?.address);
  });

  it('ignores a late response from an older block', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(200n, 101));
    const older = snapshot(100n, 100);
    older.observedAt = new Date(Date.UTC(2026, 1, 1));
    expect(await store.applySnapshot(older)).toEqual({ updated: 0, changes: 0 });
    expect((await store.listWallets(5))[0]?.balanceWei).toBe('200');
  });

  it('rejects inconsistent data for one block hash', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(200n));
    await expect(store.applySnapshot(snapshot(100n))).rejects.toThrow('Conflicting balances');
    expect((await store.listWallets(5))[0]?.balanceWei).toBe('200');
    expect(await store.history(0, 10)).toHaveLength(1);
  });

  it('reconciles a replacement block at the same height', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(200n));
    const replacement = snapshot(190n);
    replacement.blockHash = `0x${'b'.repeat(64)}`;
    await store.applySnapshot(replacement);
    expect((await store.listWallets(5))[0]?.balanceWei).toBe('190');
    expect((await store.history(0, 10))[0]?.deltaWei).toBe('-10');
  });

  it('serves exact amounts, unknown balances, freshness, and paginated history via HTTP', async () => {
    await store.registerWallets(wallets);
    await store.applySnapshot(snapshot(100000000000000001n));
    await store.applySnapshot(snapshot(100000000000000002n, 101));
    const server: Server = await new Promise((resolve, reject) => {
      const listener = createApp(store, 5).listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${url}/wallets`);
      expect(response.status).toBe(200);
      const body = await response.json() as Array<Record<string, unknown>>;
      expect(body[0]).toMatchObject({ balanceWei: '100000000000000002', balance: '0.100000000000000002', stale: true });
      expect(body[1]).toMatchObject({ balance: null, checkedAt: null, stale: true });
      expect(Object.keys(body[0]!).sort()).toEqual(
        ['index', 'address', 'balanceWei', 'blockNumber', 'blockHash', 'checkedAt', 'balance', 'stale'].sort(),
      );
      type HistoryPage = { items: Array<{ kind: string }>; nextCursor: string | null };
      const page1 = await (await fetch(`${url}/wallets/0/history?limit=1`)).json() as HistoryPage;
      expect(page1.items[0]?.kind).toBe('INFLOW');
      const page2 = await (await fetch(`${url}/wallets/0/history?limit=1&before=${page1.nextCursor}`)).json() as HistoryPage;
      expect(page2.items[0]?.kind).toBe('BASELINE');
      expect(page2.nextCursor).toBeNull();
      expect((await fetch(`${url}/wallets/0/history?limit=1000`)).status).toBe(400);
      expect((await fetch(`${url}/wallets/5/history`)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
