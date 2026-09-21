import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SignedTransaction } from '../blockchain/transaction.js';
import type { PreparedWithdrawal, WithdrawalSession, WithdrawalStore } from '../withdrawals/types.js';
import { WithdrawalError } from '../withdrawals/errors.js';

const columns = `id::text, request_hash AS "requestHash", wallet_index AS "walletIndex",
  status, signed_transaction AS "signedTransaction", tx_hash AS "transactionHash"`;

class PgWithdrawalSession implements WithdrawalSession {
  constructor(private readonly client: PoolClient, private readonly index: number) {}

  async findByKey(key: string): Promise<PreparedWithdrawal | null> {
    const result = await this.client.query<PreparedWithdrawal>(
      `SELECT ${columns} FROM withdrawals WHERE idempotency_key = $1`, [key],
    );
    return result.rows[0] ?? null;
  }
  async hasUnresolved(): Promise<boolean> {
    const result = await this.client.query(
      "SELECT 1 FROM withdrawals WHERE wallet_index = $1 AND status IN ('PREPARED', 'UNCERTAIN') LIMIT 1", [this.index],
    );
    return result.rows.length > 0;
  }
  async lastBroadcastNonce(): Promise<number | null> {
    const result = await this.client.query<{ nonce: string | null }>(
      "SELECT max(nonce) AS nonce FROM withdrawals WHERE wallet_index = $1 AND status = 'BROADCAST'", [this.index],
    );
    return result.rows[0]?.nonce == null ? null : Number(result.rows[0].nonce);
  }
  async prepare(key: string, requestHash: string, signed: SignedTransaction): Promise<PreparedWithdrawal> {
    try {
      const result = await this.client.query<PreparedWithdrawal>(`INSERT INTO withdrawals
        (id, idempotency_key, request_hash, wallet_index, nonce, destination, amount_wei, tx_hash, signed_transaction, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PREPARED') RETURNING ${columns}`, [
        randomUUID(), key, requestHash, this.index, signed.payload.nonce, signed.payload.to,
        signed.payload.value, signed.transactionHash, signed.signedTransaction,
      ]);
      return result.rows[0]!;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new WithdrawalError('WITHDRAWAL_CONFLICT', 'The idempotency key or wallet nonce is already reserved.', 409);
      }
      throw error;
    }
  }
  async markUncertain(id: string): Promise<void> {
    const result = await this.client.query(
      "UPDATE withdrawals SET status = 'UNCERTAIN' WHERE id = $1 AND wallet_index = $2 AND status <> 'BROADCAST'", [id, this.index],
    );
    if (result.rowCount !== 1) throw new Error('Withdrawal state changed unexpectedly.');
  }
  async markBroadcast(id: string): Promise<void> {
    await this.client.query('BEGIN');
    try {
      const result = await this.client.query(`UPDATE withdrawals SET status = 'BROADCAST', broadcast_at = COALESCE(broadcast_at, now())
        WHERE id = $1 AND wallet_index = $2`, [id, this.index]);
      if (result.rowCount !== 1) throw new Error('Withdrawal is missing.');
      await this.client.query(`INSERT INTO outflows (withdrawal_id, wallet_index, tx_hash, amount_wei, destination)
        SELECT id, wallet_index, tx_hash, amount_wei, destination FROM withdrawals WHERE id = $1
        ON CONFLICT (withdrawal_id) DO NOTHING`, [id]);
      await this.client.query('COMMIT');
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

export class PgWithdrawalStore implements WithdrawalStore {
  constructor(private readonly pool: Pool) {}

  async withWalletLock<T>(index: number, address: string, operation: (session: WithdrawalSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(11155112, $1) AS locked', [index]);
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new WithdrawalError('WALLET_BUSY', 'Another withdrawal is being processed for this wallet. Retry later.', 409);
      const wallet = await client.query<{ address: string }>('SELECT address FROM wallets WHERE wallet_index = $1', [index]);
      if (wallet.rows[0]?.address.toLowerCase() !== address.toLowerCase()) throw new Error('Stored wallet identity mismatch.');
      // Use this same session for every write: no pool starvation while holding locks.
      return await operation(new PgWithdrawalSession(client, index));
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(11155112, $1)', [index]); }
        catch { broken = true; }
      }
      client.release(broken);
    }
  }
}
