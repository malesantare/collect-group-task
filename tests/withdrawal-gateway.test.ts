import { type JsonRpcProvider, Wallet } from 'ethers';
import { expect, it, vi } from 'vitest';
import { SepoliaWithdrawalGateway } from '../src/blockchain/withdrawal-gateway.js';
import { EXPECTED_ADDRESSES } from './fixtures/mnemonic.js';

function mockProvider() {
  return {
    send: vi.fn(async () => '0xaa36a7'),
    getTransactionCount: vi.fn(async (_address: string, tag: string) => tag === 'pending' ? 8 : 7),
    getBalance: vi.fn(async (_address: string, tag: string) => tag === 'pending' ? 10n ** 18n : 2n * 10n ** 18n),
    getFeeData: vi.fn(async () => ({ maxFeePerGas: 20n, maxPriorityFeePerGas: 2n })),
    estimateGas: vi.fn(async () => 25001n),
    getTransaction: vi.fn(async () => null),
  };
}

it('quotes pending nonce, conservative balance, EIP-1559 fees, and rounded gas headroom', async () => {
  const rpc = mockProvider();
  const quote = await new SepoliaWithdrawalGateway(rpc as unknown as JsonRpcProvider)
    .quote(EXPECTED_ADDRESSES[0]!, EXPECTED_ADDRESSES[1]!, 123n);
  expect(quote).toMatchObject({ nonce: 8, confirmedNonce: 7, balanceWei: 10n ** 18n, gasLimit: 30002n,
    maxFeePerGas: 20n, maxPriorityFeePerGas: 2n, value: 123n, chainId: 11155111n });
  expect(rpc.estimateGas).toHaveBeenCalledWith(expect.objectContaining({ from: EXPECTED_ADDRESSES[0], to: EXPECTED_ADDRESSES[1], value: 123n }));
  expect(rpc.send).toHaveBeenCalledTimes(2);
});

it('does not attempt simulation or signing when the requested amount exceeds the balance', async () => {
  const rpc = mockProvider();
  await expect(new SepoliaWithdrawalGateway(rpc as unknown as JsonRpcProvider)
    .quote(EXPECTED_ADDRESSES[0]!, EXPECTED_ADDRESSES[1]!, 3n * 10n ** 18n))
    .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  expect(rpc.estimateGas).not.toHaveBeenCalled();
});

it('refuses a non-Sepolia serialized transaction before sending anything', async () => {
  const rpc = mockProvider();
  const raw = await new Wallet(`0x${'1'.repeat(64)}`).signTransaction({
    to: EXPECTED_ADDRESSES[0]!, value: 1n, chainId: 1n, type: 2, nonce: 0,
    gasLimit: 21000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n,
  });
  await expect(new SepoliaWithdrawalGateway(rpc as unknown as JsonRpcProvider).send(raw))
    .rejects.toMatchObject({ code: 'WRONG_NETWORK' });
  expect(rpc.send).not.toHaveBeenCalled();
});

it('rejects a balance that covers the value but not minimum gas before RPC estimation', async () => {
  const rpc = mockProvider();
  rpc.getBalance.mockResolvedValue(420122n); // 123 wei + 21000 * 20 wei costs 420123.
  rpc.estimateGas.mockRejectedValue({ code: 'CALL_EXCEPTION' });
  await expect(new SepoliaWithdrawalGateway(rpc as unknown as JsonRpcProvider)
    .quote(EXPECTED_ADDRESSES[0]!, EXPECTED_ADDRESSES[1]!, 123n))
    .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', httpStatus: 422 });
  expect(rpc.estimateGas).not.toHaveBeenCalled();
});

it('allows an exact balance for a simple transfer and its maximum gas fee', async () => {
  const rpc = mockProvider();
  rpc.getBalance.mockResolvedValue(420123n);
  rpc.estimateGas.mockResolvedValue(21000n);
  const quote = await new SepoliaWithdrawalGateway(rpc as unknown as JsonRpcProvider)
    .quote(EXPECTED_ADDRESSES[0]!, EXPECTED_ADDRESSES[1]!, 123n);
  expect(quote.balanceWei).toBe(quote.value + quote.gasLimit * quote.maxFeePerGas);
});
