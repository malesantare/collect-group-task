import type { WalletAddress } from '../blockchain/wallets.js';

export interface BalanceSnapshot {
  blockNumber: number;
  blockHash: string;
  observedAt: Date;
  balances: Array<WalletAddress & { balanceWei: bigint }>;
}

export interface StoredWallet extends WalletAddress {
  balanceWei: string | null;
  blockNumber: number | null;
  blockHash: string | null;
  checkedAt: Date | null;
}

export interface BalanceChange {
  id: string;
  kind: 'BASELINE' | 'INFLOW' | 'DECREASE';
  oldBalanceWei: string | null;
  newBalanceWei: string;
  deltaWei: string | null;
  blockNumber: number;
  blockHash: string;
  observedAt: Date;
}

export interface BalanceStore {
  registerWallets(wallets: readonly WalletAddress[]): Promise<void>;
  applySnapshot(snapshot: BalanceSnapshot): Promise<{ updated: number; changes: number }>;
  listWallets(count: number): Promise<StoredWallet[]>;
  history(index: number, limit: number, before?: string): Promise<BalanceChange[]>;
}

export interface BalanceSource {
  readSnapshot(wallets: readonly WalletAddress[]): Promise<BalanceSnapshot>;
}
