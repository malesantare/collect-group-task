import type { Pool } from 'pg';
import type { WalletAddress } from '../blockchain/wallets.js';
import type { BalanceChange, BalanceSnapshot, BalanceStore, StoredWallet } from '../balances/types.js';
import { classifyChange } from '../balances/change.js';
import { inTransaction } from './pool.js';

export class WalletIdentityError extends Error {
  constructor() {
    super('Configured wallets do not match stored addresses. Restore the original mnemonic or use a separate database.');
    this.name = 'WalletIdentityError';
  }
}

type WalletRow = Omit<StoredWallet, 'blockNumber'> & { blockNumber: string | null };
const walletColumns = `wallet_index AS index, address, balance_wei AS "balanceWei",
  block_number AS "blockNumber", block_hash AS "blockHash", checked_at AS "checkedAt"`;

export class PgBalanceStore implements BalanceStore {
  constructor(private readonly pool: Pool) {}

  async registerWallets(wallets: readonly WalletAddress[]): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(11155111, 2)');
      for (const wallet of wallets) {
        const existing = await client.query<{ address: string }>(
          'SELECT address FROM wallets WHERE wallet_index = $1', [wallet.index],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].address.toLowerCase() !== wallet.address.toLowerCase()) throw new WalletIdentityError();
        } else {
          await client.query('INSERT INTO wallets (wallet_index, address) VALUES ($1, $2)', [wallet.index, wallet.address]);
        }
      }
    });
  }

  async applySnapshot(snapshot: BalanceSnapshot): Promise<{ updated: number; changes: number }> {
    if (!Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < 0
      || !/^0x[0-9a-f]{64}$/i.test(snapshot.blockHash) || !Number.isFinite(snapshot.observedAt.getTime())
      || new Set(snapshot.balances.map((balance) => balance.index)).size !== snapshot.balances.length) {
      throw new Error('Invalid balance snapshot.');
    }
    return inTransaction(this.pool, async (client) => {
      let updated = 0;
      let changes = 0;
      // A consistent lock order avoids deadlocks between simultaneous refreshes.
      for (const balance of [...snapshot.balances].sort((a, b) => a.index - b.index)) {
        if (balance.balanceWei < 0n || balance.balanceWei >= 2n ** 256n) throw new Error('Invalid balance amount.');
        const result = await client.query<WalletRow>(
          `SELECT ${walletColumns} FROM wallets WHERE wallet_index = $1 FOR UPDATE`, [balance.index],
        );
        const previous = result.rows[0];
        if (!previous || previous.address.toLowerCase() !== balance.address.toLowerCase()) throw new WalletIdentityError();
        // Old requests cannot overwrite a newer observation.
        if ((previous.blockNumber !== null && Number(previous.blockNumber) > snapshot.blockNumber)
          || (previous.checkedAt !== null && previous.checkedAt > snapshot.observedAt)) continue;
        const oldBalance = previous.balanceWei === null ? null : BigInt(previous.balanceWei);
        if (previous.blockHash === snapshot.blockHash && oldBalance !== balance.balanceWei) {
          throw new Error('Conflicting balances for the same block hash.');
        }
        const change = classifyChange(oldBalance, balance.balanceWei);
        if (change) {
          await client.query(`INSERT INTO balance_changes
            (wallet_index, kind, old_balance_wei, new_balance_wei, delta_wei, block_number, block_hash, observed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
            balance.index, change.kind, previous.balanceWei, balance.balanceWei.toString(),
            change.delta?.toString() ?? null, snapshot.blockNumber, snapshot.blockHash, snapshot.observedAt,
          ]);
          changes++;
        }
        await client.query(`UPDATE wallets SET balance_wei = $2, block_number = $3,
          block_hash = $4, checked_at = $5 WHERE wallet_index = $1`, [
          balance.index, balance.balanceWei.toString(), snapshot.blockNumber, snapshot.blockHash, snapshot.observedAt,
        ]);
        updated++;
      }
      return { updated, changes };
    });
  }

  async listWallets(count: number): Promise<StoredWallet[]> {
    const result = await this.pool.query<WalletRow>(
      `SELECT ${walletColumns} FROM wallets WHERE wallet_index < $1 ORDER BY wallet_index`, [count],
    );
    return result.rows.map((row) => ({ ...row, blockNumber: row.blockNumber === null ? null : Number(row.blockNumber) }));
  }

  async history(index: number, limit: number, before?: string): Promise<BalanceChange[]> {
    const result = await this.pool.query<Omit<BalanceChange, 'blockNumber'> & { blockNumber: string }>(
      `SELECT id::text, kind, old_balance_wei AS "oldBalanceWei", new_balance_wei AS "newBalanceWei",
        delta_wei AS "deltaWei", block_number AS "blockNumber", block_hash AS "blockHash", observed_at AS "observedAt"
        FROM balance_changes WHERE wallet_index = $1 AND ($3::bigint IS NULL OR id < $3::bigint)
        ORDER BY balance_changes.id DESC LIMIT $2`, [index, limit, before ?? null],
    );
    return result.rows.map((row) => ({ ...row, blockNumber: Number(row.blockNumber) }));
  }
}
