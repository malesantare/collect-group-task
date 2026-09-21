import { initializeWithdrawalEnvironment } from '../setup/withdrawal-env.js';

try {
  const changed = await initializeWithdrawalEnvironment('.env');
  console.info(changed ? 'Added WITHDRAWAL_API_KEY to .env without printing it.' : 'Existing WITHDRAWAL_API_KEY preserved.');
} catch {
  console.error('Withdrawal setup failed. Create .env first and check file permissions.');
  process.exitCode = 1;
}
