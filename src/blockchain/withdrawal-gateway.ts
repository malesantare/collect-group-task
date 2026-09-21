import { type JsonRpcProvider, isError, Transaction } from 'ethers';
import { SepoliaBalanceSource } from './balances.js';
import type { TransactionQuote, WithdrawalGateway } from '../withdrawals/types.js';
import { WithdrawalError } from '../withdrawals/errors.js';

export class SepoliaWithdrawalGateway implements WithdrawalGateway {
  constructor(private readonly rpc: JsonRpcProvider) {}
  async assertNetwork(): Promise<void> {
    await new SepoliaBalanceSource(this.rpc).assertNetwork();
  }

  async quote(from: string, to: string, value: bigint): Promise<TransactionQuote> {
    await this.assertNetwork();
    const [nonce, confirmedNonce, pendingBalance, latestBalance, fees] = await Promise.all([
      this.rpc.getTransactionCount(from, 'pending'), this.rpc.getTransactionCount(from, 'latest'),
      this.rpc.getBalance(from, 'pending'), this.rpc.getBalance(from, 'latest'), this.rpc.getFeeData(),
    ]);
    const balanceWei = pendingBalance < latestBalance ? pendingBalance : latestBalance;
    if (balanceWei < value) throw new WithdrawalError('INSUFFICIENT_FUNDS', 'Insufficient ETH balance.', 422);
    if (fees.maxFeePerGas === null || fees.maxPriorityFeePerGas === null) {
      throw new WithdrawalError('FEES_UNAVAILABLE', 'RPC did not return EIP-1559 fees.', 503);
    }
    // Even a plain ETH transfer needs 21000 gas. Check this before estimation:
    // some RPC nodes report an unaffordable estimate as CALL_EXCEPTION.
    if (balanceWei < value + 21000n * fees.maxFeePerGas) {
      throw new WithdrawalError('INSUFFICIENT_FUNDS', 'Insufficient ETH for the amount plus the maximum gas fee.', 422);
    }
    const input = { from, to, value, nonce, chainId: 11155111n, type: 2,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, data: '0x' };
    let estimate: bigint;
    try { estimate = await this.rpc.estimateGas(input); }
    catch (error) {
      if (isError(error, 'INSUFFICIENT_FUNDS')) throw new WithdrawalError('INSUFFICIENT_FUNDS', 'Insufficient ETH for value and fees.', 422);
      if (isError(error, 'CALL_EXCEPTION')) throw new WithdrawalError('TRANSFER_REVERTS', 'RPC could not simulate the ETH transfer.', 422);
      throw error;
    }
    // Leave simple EOA transfers at 21000; add 20% headroom for contract execution.
    const gasLimit = estimate === 21000n ? estimate : (estimate * 120n + 99n) / 100n;
    await this.assertNetwork();
    return { ...input, gasLimit, confirmedNonce, balanceWei };
  }

  async send(raw: string): Promise<string> {
    if (Transaction.from(raw).chainId !== 11155111n) throw new WithdrawalError('WRONG_NETWORK', 'Only Sepolia transactions may be broadcast.', 422);
    await this.assertNetwork();
    return this.rpc.send('eth_sendRawTransaction', [raw]) as Promise<string>;
  }

  async isKnown(hash: string): Promise<boolean> {
    await this.assertNetwork();
    const tx = await this.rpc.getTransaction(hash);
    return tx !== null && tx.chainId === 11155111n && tx.hash.toLowerCase() === hash.toLowerCase();
  }
}
