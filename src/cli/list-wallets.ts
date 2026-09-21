import { generateWallets } from '../blockchain/wallets.js';
import { ConfigurationError, loadConfig } from '../config/env.js';

try {
  const config = loadConfig();
  console.info(JSON.stringify(generateWallets(config.mnemonic, config.walletCount), null, 2));
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : 'Wallet generation failed.');
  process.exitCode = 1;
}
