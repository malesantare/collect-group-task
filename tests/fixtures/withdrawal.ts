import { Transaction } from 'ethers';
import { vi } from 'vitest';
import type { TransactionQuote } from '../../src/withdrawals/types.js';

export function fakeGateway() {
  return {
    assertNetwork: vi.fn(async () => {}),
    quote: vi.fn(async (from: string, to: string, value: bigint): Promise<TransactionQuote> => ({
      from, to, value, chainId: 11155111n, nonce: 7, confirmedNonce: 7,
      balanceWei: 10n ** 18n, gasLimit: 21000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n,
    })),
    send: vi.fn(async (raw: string) => Transaction.from(raw).hash!),
    isKnown: vi.fn(async (_hash: string) => false),
  };
}
