import { createHash } from 'node:crypto';
import type { WalletAddress } from '../blockchain/wallets.js';
import { describeSignedTransaction, type SignedTransaction, type TransactionSigner } from '../blockchain/transaction.js';
import type { PreparedWithdrawal, WithdrawalGateway, WithdrawalSession, WithdrawalStore } from './types.js';
import { WithdrawalError } from './errors.js';
import { parseWithdrawalRequest, validateIdempotencyKey } from './request.js';

export interface WithdrawalResult extends SignedTransaction {
  status: 'SIGNED' | 'BROADCAST' | 'UNCERTAIN';
  withdrawalId: string | null;
}

export class WithdrawalService {
  constructor(
    private readonly wallets: readonly WalletAddress[],
    private readonly signer: TransactionSigner,
    private readonly gateway: WithdrawalGateway,
    private readonly store: WithdrawalStore,
  ) {}

  async withdraw(input: unknown, idempotencyKey?: string): Promise<WithdrawalResult> {
    const request = parseWithdrawalRequest(input, this.wallets.length);
    const wallet = this.wallets[request.walletIndex]!;
    const key = request.broadcast ? validateIdempotencyKey(idempotencyKey) : undefined;
    const requestHash = createHash('sha256').update(JSON.stringify([
      request.walletIndex, request.to.toLowerCase(), request.value.toString(), true,
    ])).digest('hex');

    return this.store.withWalletLock(wallet.index, wallet.address, async (session) => {
      if (key) {
        const existing = await session.findByKey(key);
        if (existing) {
          if (existing.requestHash !== requestHash || existing.walletIndex !== wallet.index) {
            throw new WithdrawalError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key belongs to a different request.', 409);
          }
          return this.broadcast(existing, session);
        }
      }
      if (await session.hasUnresolved()) {
        throw new WithdrawalError('WITHDRAWAL_UNRESOLVED', 'Retry the unresolved withdrawal with its original Idempotency-Key before creating another.', 409);
      }
      const quote = await this.gateway.quote(wallet.address, request.to, request.value);
      if (quote.from !== wallet.address || quote.to !== request.to || quote.value !== request.value) throw new Error('RPC quote does not match request.');
      if (request.broadcast) {
        const lastNonce = await session.lastBroadcastNonce();
        if (quote.nonce !== quote.confirmedNonce || (lastNonce !== null && lastNonce >= quote.confirmedNonce)) {
          throw new WithdrawalError('WALLET_PENDING', 'Wait for the previous wallet transaction to be mined before creating another broadcast.', 409);
        }
      }
      if (request.value + quote.gasLimit * quote.maxFeePerGas > quote.balanceWei) {
        throw new WithdrawalError('INSUFFICIENT_FUNDS', 'Insufficient ETH for the amount plus the maximum gas fee.', 422);
      }
      await this.gateway.assertNetwork();
      const signed = await this.signer.sign(wallet.index, quote);
      if (!key) return { ...signed, status: 'SIGNED', withdrawalId: null };
      const prepared = await session.prepare(key, requestHash, signed);
      return this.broadcast(prepared, session);
    });
  }

  private async broadcast(record: PreparedWithdrawal, session: WithdrawalSession): Promise<WithdrawalResult> {
    const signed = describeSignedTransaction(record.signedTransaction);
    if (signed.transactionHash !== record.transactionHash) throw new Error('Stored transaction hash mismatch.');
    if (record.status === 'BROADCAST') return { ...signed, status: 'BROADCAST', withdrawalId: record.id };
    await this.gateway.assertNetwork();
    // Commit uncertainty before the network call. A crash cannot lose the signed bytes.
    await session.markUncertain(record.id);
    let accepted = false;
    try { accepted = (await this.gateway.send(record.signedTransaction)).toLowerCase() === record.transactionHash.toLowerCase(); }
    catch { /* RPC failure may occur after acceptance. Probe the precomputed hash. */ }
    if (!accepted) {
      try { accepted = await this.gateway.isKnown(record.transactionHash); }
      catch { /* Preserve UNCERTAIN so retry uses exactly the same bytes. */ }
    }
    if (!accepted) return { ...signed, status: 'UNCERTAIN', withdrawalId: record.id };
    // Commit the status and the OUTFLOW event together, only after evidence of broadcast.
    await session.markBroadcast(record.id);
    return { ...signed, status: 'BROADCAST', withdrawalId: record.id };
  }
}
