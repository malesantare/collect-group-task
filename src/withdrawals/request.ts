import { getAddress, isAddress, parseEther, ZeroAddress } from 'ethers';
import { z } from 'zod';
import { WithdrawalError } from './errors.js';

const schema = z.object({
  walletIndex: z.number().int().min(0).max(19),
  to: z.string().refine(isAddress).transform(getAddress).refine((value) => value !== ZeroAddress),
  amount: z.string().max(80).regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/),
  broadcast: z.boolean().default(false),
}).strict();

export function parseWithdrawalRequest(input: unknown, walletCount: number) {
  const result = schema.safeParse(input);
  if (!result.success) throw new WithdrawalError('INVALID_REQUEST', 'Expected walletIndex, a valid destination, an ETH amount string, and optional boolean broadcast.', 400);
  if (result.data.walletIndex >= walletCount) throw new WithdrawalError('WALLET_NOT_FOUND', 'Wallet is not active.', 404);
  let value: bigint;
  try { value = parseEther(result.data.amount); }
  catch { throw new WithdrawalError('INVALID_AMOUNT', 'Invalid ETH amount.', 400); }
  if (value <= 0n || value >= 2n ** 256n) throw new WithdrawalError('INVALID_AMOUNT', 'Amount must be positive and fit in uint256 wei.', 400);
  return { walletIndex: result.data.walletIndex, to: result.data.to, value, broadcast: result.data.broadcast };
}

export function validateIdempotencyKey(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new WithdrawalError('IDEMPOTENCY_KEY_REQUIRED', 'Broadcast requires an Idempotency-Key of 8 to 128 ASCII letters, digits, dots, colons, underscores, or hyphens.', 400);
  }
  return value;
}
