import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { formatEther, parseEther, Transaction } from 'ethers';
import { z } from 'zod';
import { loadRuntimeConfig, loadWithdrawalApiKey } from '../config/env.js';
import { createPool } from '../db/pool.js';
import type { BalanceChange } from '../balances/types.js';
import type { WithdrawalResult } from '../withdrawals/service.js';

class DemoError extends Error {}
const requestFile = 'data/review-request.json';
const resultFile = 'data/review-result.json';
const amount = '0.00001';
const requestSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  body: z.object({ walletIndex: z.literal(0), to: z.string(), amount: z.literal(amount), broadcast: z.literal(true) }),
});
const resultSchema = z.object({
  status: z.literal('BROADCAST'),
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  withdrawalId: z.uuid(),
});
type Wallet = { index: number; address: string; balance: string | null; stale: boolean };

async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DemoError(`Cannot read ${path}. Keep the saved request for retries.`);
  }
}

async function main() {
  const command = process.argv[2] ?? 'status';
  if (!['status', 'sign', 'send', 'retry'].includes(command)) throw new DemoError('Use demo, demo:sign, demo:send, or demo:retry.');
  const config = loadRuntimeConfig();
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
  const pool = createPool(config.databaseUrl);

  async function api<T>(path: string, body?: unknown, key?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.Authorization = `Bearer ${loadWithdrawalApiKey()}`;
    }
    if (key) headers['Idempotency-Key'] = key;
    let response: Response;
    try {
      response = await fetch(base + path, {
        headers, signal: AbortSignal.timeout(60000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      });
    } catch {
      throw new DemoError('API did not respond. Check npm run dev. For a send, retry with npm run demo:retry.');
    }
    const result = await response.json() as { error?: string };
    if (!response.ok) {
      if (result.error === 'INSUFFICIENT_FUNDS') throw new DemoError('Wallet 0 needs more Sepolia ETH for the amount plus gas. Fund it, then retry the same command.');
      if (result.error === 'UNAUTHORIZED') throw new DemoError('API key mismatch. Use the same .env as the running server.');
      const code = /^[A-Z_]+$/.test(result.error ?? '') ? result.error : 'REQUEST_FAILED';
      throw new DemoError(`API ${response.status}: ${code}. A saved send must be retried with npm run demo:retry.`);
    }
    return result as T;
  }

  async function counts() {
    return (await pool.query(`SELECT (SELECT count(*) FROM withdrawals)::text AS withdrawals,
      (SELECT count(*) FROM outflows)::text AS outflows`)).rows[0] as { withdrawals: string; outflows: string };
  }

  try {
    const wallets = await api<Wallet[]>('/wallets');
    if (command === 'status') {
      for (const wallet of wallets) console.info(`Wallet ${wallet.index}: ${wallet.address} | ${wallet.balance ?? 'not read yet'} ETH${wallet.stale ? ' (stale)' : ''}`);
      if (wallets[0]) {
        console.info(`\nFund wallet 0 with 0.001 Sepolia ETH: ${wallets[0].address}`);
        const history = await api<{ items: BalanceChange[] }>('/wallets/0/history?limit=5');
        console.info('\nLatest wallet 0 balance changes:');
        for (const entry of history.items) console.info(`${entry.kind}: change ${entry.deltaWei === null ? '-' : formatEther(entry.deltaWei)} ETH; balance ${formatEther(entry.newBalanceWei)} ETH; block ${entry.blockNumber}`);
      }
      const saved = await readJson(resultFile);
      if (saved !== undefined) {
        const previous = resultSchema.parse(saved);
        const row = (await pool.query('SELECT count(*)::integer AS count FROM outflows WHERE withdrawal_id = $1', [previous.withdrawalId])).rows[0];
        console.info(`\nDemo withdrawal: ${previous.transactionHash}; saved outflows: ${row.count}`);
      }
      return;
    }
    if (!wallets[0] || !wallets[1]) throw new DemoError('The demo needs WALLET_COUNT >= 2. Update .env and restart the server.');
    const body = { walletIndex: 0, to: wallets[1].address, amount, broadcast: command !== 'sign' };
    if (command === 'sign') {
      const before = await counts();
      const result = await api<WithdrawalResult>('/withdrawals', body);
      const tx = Transaction.from(result.signedTransaction);
      if (result.status !== 'SIGNED' || result.withdrawalId !== null || tx.from !== wallets[0].address
        || tx.to !== body.to || tx.value !== parseEther(amount) || tx.chainId !== 11155111n || tx.hash !== result.transactionHash) {
        throw new DemoError('Signed transaction does not match the requested Sepolia transfer.');
      }
      if (JSON.stringify(await counts()) !== JSON.stringify(before)) throw new DemoError('Withdrawal/outflow counts changed during signing. Check for concurrent requests.');
      console.info(JSON.stringify(result, null, 2));
      console.info('\nPASS: signature matches wallet 0; no withdrawal or outflow was created.');
      return;
    }

    let saved = await readJson(requestFile);
    if (saved === undefined) {
      if (command === 'retry') throw new DemoError('No saved request. Run npm run demo:send first.');
      // Persist BEFORE calling the API. Failure must never cause a new retry key.
      if (await readJson(resultFile) !== undefined) throw new DemoError('Saved result exists without its request. Restore data/review-request.json before retrying.');
      saved = { key: randomUUID(), body };
      await mkdir('data', { recursive: true });
      await writeFile(requestFile, JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 });
    }
    const request = requestSchema.parse(saved);
    if (request.body.to !== body.to) throw new DemoError('Saved request belongs to a different wallet set. Restore its original .env and database.');
    const previousData = await readJson(resultFile);
    const previous = previousData === undefined ? undefined : resultSchema.parse(previousData);
    if (previous) {
      const existing = await pool.query(
        "SELECT 1 FROM withdrawals WHERE id = $1 AND tx_hash = $2 AND status = 'BROADCAST'",
        [previous.withdrawalId, previous.transactionHash],
      );
      if (existing.rowCount !== 1) throw new DemoError('Saved result is missing from this database. Restore the original database before retrying.');
    }
    const before = await counts();
    const result = await api<WithdrawalResult>('/withdrawals', request.body, request.key);
    if (result.status === 'UNCERTAIN') throw new DemoError('Broadcast is uncertain. Keep the saved request and run npm run demo:retry.');
    const completed = resultSchema.parse(result);
    if (previous && (previous.transactionHash !== completed.transactionHash || previous.withdrawalId !== completed.withdrawalId)) {
      throw new DemoError('Retry returned a different transaction or withdrawal ID.');
    }
    const row = (await pool.query('SELECT count(*)::integer AS count FROM outflows WHERE withdrawal_id = $1', [completed.withdrawalId])).rows[0];
    if (row.count !== 1) throw new DemoError('Expected exactly one outflow for this withdrawal.');
    if (previous && JSON.stringify(await counts()) !== JSON.stringify(before)) throw new DemoError('Record counts changed during retry. Check for concurrent requests.');
    if (!previous) await writeFile(resultFile, JSON.stringify(completed, null, 2), { flag: 'wx', mode: 0o600 });
    console.info(previous ? 'PASS: same hash and withdrawal ID; no duplicate records.' : 'PASS: broadcast accepted; exactly one outflow saved.');
    console.info(`https://sepolia.etherscan.io/tx/${completed.transactionHash}`);
    console.info('Wait for Success in the explorer, then run npm run demo to see updated balances.');
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof DemoError ? error.message : 'Demo failed. Check the server, database, .env, and saved files in data/. No secrets were printed.');
  process.exitCode = 1;
});
