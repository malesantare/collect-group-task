import { initializeDatabaseEnvironment } from '../setup/database-env.js';

try {
  const changed = await initializeDatabaseEnvironment('.env');
  console.info(changed ? 'Added local PostgreSQL settings to .env.' : 'Existing DATABASE_URL preserved.');
} catch {
  console.error('Database setup failed. Create .env first and check POSTGRES_PORT and file permissions.');
  process.exitCode = 1;
}
