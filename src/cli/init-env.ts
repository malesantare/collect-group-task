import { initializeTestEnvironment } from '../setup/init-env.js';

try {
  await initializeTestEnvironment('.env');
  console.info('Created .env with a new test-only mnemonic. Its value was not printed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Environment initialization failed.');
  process.exitCode = 1;
}
