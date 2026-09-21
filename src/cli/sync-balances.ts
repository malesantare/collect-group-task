import { generateWallets } from '../blockchain/wallets.js';
import { createRpcProvider, SepoliaBalanceSource, WrongNetworkError } from '../blockchain/balances.js';
import { ConfigurationError, loadRuntimeConfig } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { PgBalanceStore, WalletIdentityError } from '../db/balance-store.js';
import { BalanceService } from '../balances/service.js';

try {
  const config = loadRuntimeConfig();
  const pool = createPool(config.databaseUrl);
  const rpc = createRpcProvider(config.rpcUrl, config.rpcTimeoutMs);
  try {
    const wallets = generateWallets(config.mnemonic, config.walletCount);
    const store = new PgBalanceStore(pool);
    const source = new SepoliaBalanceSource(rpc);
    await source.assertNetwork();
    await migrate(pool);
    await store.registerWallets(wallets);
    const result = await new BalanceService(wallets, source, store).refresh();
    console.info(`Saved ${result.updated} balances; recorded ${result.changes} history entries.`);
  } finally {
    rpc.destroy();
    await pool.end();
  }
} catch (error) {
  console.error(error instanceof ConfigurationError || error instanceof WalletIdentityError || error instanceof WrongNetworkError
    ? error.message : 'Balance synchronization failed. Check PostgreSQL and RPC connectivity.');
  process.exitCode = 1;
}
