import { ConfigurationError, loadRuntimeConfig } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

try {
  const pool = createPool(loadRuntimeConfig().databaseUrl);
  try {
    await migrate(pool);
    console.info('Database migrations applied.');
  } finally { await pool.end(); }
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : 'Migration failed. Check PostgreSQL connectivity and migration files.');
  process.exitCode = 1;
}
