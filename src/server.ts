import type { Server } from 'node:http';
import { createApp } from './app.js';
import { generateWallets } from './blockchain/wallets.js';
import { createRpcProvider, SepoliaBalanceSource, WrongNetworkError } from './blockchain/balances.js';
import { ConfigurationError, loadRuntimeConfig, loadWithdrawalApiKey } from './config/env.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PgBalanceStore, WalletIdentityError } from './db/balance-store.js';
import { BalanceService } from './balances/service.js';
import { BalancePoller } from './balances/poller.js';
import { HdTransactionSigner } from './blockchain/transaction.js';
import { SepoliaWithdrawalGateway } from './blockchain/withdrawal-gateway.js';
import { PgWithdrawalStore } from './db/withdrawal-store.js';
import { WithdrawalService } from './withdrawals/service.js';

async function main() {
  const config = loadRuntimeConfig();
  const apiKey = loadWithdrawalApiKey();
  const wallets = generateWallets(config.mnemonic, config.walletCount);
  const pool = createPool(config.databaseUrl);
  const rpc = createRpcProvider(config.rpcUrl, config.rpcTimeoutMs);
  const store = new PgBalanceStore(pool);
  const source = new SepoliaBalanceSource(rpc);
  const service = new BalanceService(wallets, source, store);
  const withdrawals = new WithdrawalService(wallets, new HdTransactionSigner(config.mnemonic, config.walletCount),
    new SepoliaWithdrawalGateway(rpc), new PgWithdrawalStore(pool));
  const poller = new BalancePoller(() => service.refresh(), config.pollIntervalMs, (error) => {
    console.error(error instanceof WrongNetworkError ? error.message
      : 'Balance refresh failed. Previous balances were preserved; the next cycle will retry.');
  });
  let server: Server | undefined;
  async function closeResources() {
    const httpClosed = new Promise<void>((resolve) => {
      if (server?.listening) server.close(() => resolve());
      else resolve();
    });
    await poller.stop();
    await httpClosed;
    rpc.destroy();
    await pool.end();
  }

  try {
    await source.assertNetwork();
    await migrate(pool);
    await store.registerWallets(wallets);
    await new Promise<void>((resolve, reject) => {
      server = createApp(store, config.walletCount, { service: withdrawals, apiKey }).listen(config.port, config.host, (error) => {
        if (error) reject(error);
        else resolve();
      });
      server.once('error', reject);
    });
    console.info(`Wallet Watcher listening on ${config.host}:${config.port}; tracking ${wallets.length} Sepolia wallets.`);
    poller.start();

    let stopping = false;
    async function shutdown() {
      if (stopping) return;
      stopping = true;
      console.info('Stopping HTTP server and balance polling...');
      const timeout = setTimeout(() => process.exit(1), 30000);
      timeout.unref();
      try { await closeResources(); }
      catch { process.exitCode = 1; }
      finally { clearTimeout(timeout); }
    }
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  } catch (error) {
    await closeResources();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError || error instanceof WalletIdentityError || error instanceof WrongNetworkError
    ? error.message : 'Server startup failed. Check PostgreSQL, RPC, port availability, and migrations.');
  process.exitCode = 1;
});
