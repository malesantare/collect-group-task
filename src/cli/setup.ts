import { access } from 'node:fs/promises';
import { initializeTestEnvironment } from '../setup/init-env.js';
import { initializeDatabaseEnvironment } from '../setup/database-env.js';
import { initializeWithdrawalEnvironment } from '../setup/withdrawal-env.js';

try {
  try { await access('.env'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await initializeTestEnvironment('.env');
  }
  await initializeDatabaseEnvironment('.env');
  await initializeWithdrawalEnvironment('.env');
  console.info('Local setup ready. Existing wallets and credentials were preserved.');
} catch {
  console.error('Setup failed. Check .env and directory permissions. No secrets were printed.');
  process.exitCode = 1;
}
