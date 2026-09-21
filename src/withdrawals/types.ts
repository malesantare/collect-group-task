import type { SignedTransaction, TransactionInput } from '../blockchain/transaction.js';

export interface TransactionQuote extends TransactionInput {
  balanceWei: bigint;
  confirmedNonce: number;
}
export interface WithdrawalGateway {
  assertNetwork(): Promise<void>;
  quote(from: string, to: string, value: bigint): Promise<TransactionQuote>;
  send(raw: string): Promise<string>;
  isKnown(hash: string): Promise<boolean>;
}
export interface PreparedWithdrawal {
  id: string;
  requestHash: string;
  walletIndex: number;
  status: 'PREPARED' | 'UNCERTAIN' | 'BROADCAST';
  signedTransaction: string;
  transactionHash: string;
}
export interface WithdrawalSession {
  findByKey(key: string): Promise<PreparedWithdrawal | null>;
  hasUnresolved(): Promise<boolean>;
  lastBroadcastNonce(): Promise<number | null>;
  prepare(key: string, requestHash: string, signed: SignedTransaction): Promise<PreparedWithdrawal>;
  markUncertain(id: string): Promise<void>;
  markBroadcast(id: string): Promise<void>;
}
export interface WithdrawalStore {
  withWalletLock<T>(index: number, address: string, operation: (session: WithdrawalSession) => Promise<T>): Promise<T>;
}
