import type { WalletAddress } from '../blockchain/wallets.js';
import type { BalanceSource, BalanceStore } from './types.js';

export class BalanceService {
  constructor(
    private readonly wallets: readonly WalletAddress[],
    private readonly source: BalanceSource,
    private readonly store: Pick<BalanceStore, 'applySnapshot'>,
  ) {}

  async refresh(): Promise<{ updated: number; changes: number }> {
    const snapshot = await this.source.readSnapshot(this.wallets);
    return this.store.applySnapshot(snapshot);
  }
}
