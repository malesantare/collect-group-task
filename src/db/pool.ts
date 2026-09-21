import { Pool, type PoolClient } from 'pg';

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000,
  });
  pool.on('error', () => console.error('Idle PostgreSQL connection failed.'));
  return pool;
}

export async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}
