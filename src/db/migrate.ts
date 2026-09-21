import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { inTransaction } from './pool.js';

export async function migrate(pool: Pool): Promise<void> {
  const migrations = await Promise.all(['001_balances.sql', '002_withdrawals.sql'].map(async (name, index) => {
    const sql = await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
    return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  await inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(11155111, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const { version, sql, checksum } of migrations) {
      const applied = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', [version]);
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== checksum) throw new Error('Applied migration checksum changed.');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
    }
  });
}
