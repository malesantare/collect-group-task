import { describe, expect, it, vi } from 'vitest';
import { Transaction } from 'ethers';
import { WithdrawalService } from '../src/withdrawals/service.js';
import { HdTransactionSigner, type SignedTransaction } from '../src/blockchain/transaction.js';
import { generateWallets } from '../src/blockchain/wallets.js';
import { WrongNetworkError } from '../src/blockchain/balances.js';
import type { PreparedWithdrawal, WithdrawalSession } from '../src/withdrawals/types.js';
import { fakeGateway } from './fixtures/withdrawal.js';
import { TEST_MNEMONIC } from './fixtures/mnemonic.js';

function setup() {
  const wallets = generateWallets(TEST_MNEMONIC, 2);
  const gateway = fakeGateway();
  const signer = new HdTransactionSigner(TEST_MNEMONIC, 2);
  const sign = vi.spyOn(signer, 'sign');
  let record: PreparedWithdrawal | null = null;
  let storedKey: string | undefined;
  const session = {
    findByKey: vi.fn(async (key: string) => key === storedKey && record ? { ...record } : null),
    hasUnresolved: vi.fn(async () => record !== null && record.status !== 'BROADCAST'),
    lastBroadcastNonce: vi.fn(async (): Promise<number | null> => record?.status === 'BROADCAST' ? Transaction.from(record.signedTransaction).nonce : null),
    prepare: vi.fn(async (key: string, requestHash: string, signed: SignedTransaction): Promise<PreparedWithdrawal> => {
      storedKey = key;
      record = { id: 'withdrawal-1', walletIndex: 0, requestHash, status: 'PREPARED',
        signedTransaction: signed.signedTransaction, transactionHash: signed.transactionHash };
      return { ...record };
    }),
    markUncertain: vi.fn(async () => { record!.status = 'UNCERTAIN'; }),
    markBroadcast: vi.fn(async () => { record!.status = 'BROADCAST'; }),
  };
  const store = { withWalletLock: async <T>(_index: number, _address: string, action: (s: WithdrawalSession) => Promise<T>) => action(session) };
  const service = new WithdrawalService(wallets, signer, gateway, store);
  const request = { walletIndex: 0, to: wallets[1]!.address, amount: '0.01', broadcast: true };
  return { service, session, gateway, sign, request };
}

describe('withdrawal lifecycle', () => {
  it('signs without broadcasting or saving a withdrawal or outflow', async () => {
    const { service, request, gateway, session } = setup();
    const result = await service.withdraw({ ...request, broadcast: false });
    expect(result.status).toBe('SIGNED');
    expect(result.withdrawalId).toBeNull();
    expect(Transaction.from(result.signedTransaction).value).toBe(10000000000000000n);
    expect(gateway.send).not.toHaveBeenCalled();
    expect(session.prepare).not.toHaveBeenCalled();
    expect(session.markBroadcast).not.toHaveBeenCalled();
  });
  it('requires an idempotency key before any broadcast preparation', async () => {
    const { service, request, gateway } = setup();
    await expect(service.withdraw(request)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(gateway.quote).not.toHaveBeenCalled();
  });
  it('replays a successful request without signing or broadcasting again', async () => {
    const { service, request, gateway, session, sign } = setup();
    const first = await service.withdraw(request, 'withdrawal-test-001');
    const second = await service.withdraw({ ...request, amount: '0.010' }, 'withdrawal-test-001');
    expect(first.status).toBe('BROADCAST');
    expect(second).toEqual(first);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(gateway.send).toHaveBeenCalledTimes(1);
    expect(session.markBroadcast).toHaveBeenCalledTimes(1);
  });
  it('rejects the same key used for a different transfer', async () => {
    const { service, request } = setup();
    await service.withdraw(request, 'withdrawal-test-001');
    await expect(service.withdraw({ ...request, amount: '0.02' }, 'withdrawal-test-001'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('checks the amount plus maximum fees before signing', async () => {
    const { service, request, gateway, sign } = setup();
    const quote = gateway.quote.getMockImplementation()!;
    gateway.quote.mockImplementation(async (...args) => ({ ...await quote(...args), balanceWei: 10000000000000000n }));
    await expect(service.withdraw({ ...request, broadcast: false })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(sign).not.toHaveBeenCalled();
  });
  it('checks the network before signing', async () => {
    const { service, request, gateway, sign } = setup();
    gateway.assertNetwork.mockRejectedValue(new WrongNetworkError());
    await expect(service.withdraw({ ...request, broadcast: false })).rejects.toBeInstanceOf(WrongNetworkError);
    expect(sign).not.toHaveBeenCalled();
  });
  it('keeps an uncertain send without an outflow, then retries identical bytes', async () => {
    const { service, request, gateway, session, sign } = setup();
    gateway.send.mockRejectedValueOnce(new Error('timeout'));
    const first = await service.withdraw(request, 'withdrawal-test-001');
    expect(first.status).toBe('UNCERTAIN');
    expect(session.markBroadcast).not.toHaveBeenCalled();
    await expect(service.withdraw(request, 'withdrawal-test-002')).rejects.toMatchObject({ code: 'WITHDRAWAL_UNRESOLVED' });
    const second = await service.withdraw(request, 'withdrawal-test-001');
    expect(second.status).toBe('BROADCAST');
    expect(gateway.send.mock.calls[0]).toEqual(gateway.send.mock.calls[1]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(gateway.quote).toHaveBeenCalledTimes(1);
  });
  it('records an outflow after an RPC error only if the transaction hash is found', async () => {
    const { service, request, gateway, session } = setup();
    gateway.send.mockRejectedValue(new Error('already known'));
    gateway.isKnown.mockResolvedValue(true);
    expect((await service.withdraw(request, 'withdrawal-test-001')).status).toBe('BROADCAST');
    expect(session.markBroadcast).toHaveBeenCalledTimes(1);
  });
  it('does not trust an unexpected hash returned by the RPC', async () => {
    const { service, request, gateway, session } = setup();
    gateway.send.mockResolvedValue(`0x${'0'.repeat(64)}`);
    expect((await service.withdraw(request, 'withdrawal-test-001')).status).toBe('UNCERTAIN');
    expect(session.markBroadcast).not.toHaveBeenCalled();
  });
  it('does not broadcast if persistence of the signed transaction fails', async () => {
    const { service, request, gateway, session } = setup();
    session.prepare.mockRejectedValue(new Error('database unavailable'));
    await expect(service.withdraw(request, 'withdrawal-test-001')).rejects.toThrow();
    expect(gateway.send).not.toHaveBeenCalled();
  });
  it('preserves signed bytes if the post-broadcast database write fails', async () => {
    const { service, request, gateway, session, sign } = setup();
    session.markBroadcast.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.withdraw(request, 'withdrawal-test-001')).rejects.toThrow();
    expect((await service.withdraw(request, 'withdrawal-test-001')).status).toBe('BROADCAST');
    expect(gateway.send.mock.calls[0]).toEqual(gateway.send.mock.calls[1]);
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it('allows only one pending broadcast per wallet', async () => {
    const { service, request, gateway, sign } = setup();
    const quote = gateway.quote.getMockImplementation()!;
    gateway.quote.mockImplementation(async (...args) => ({ ...await quote(...args), confirmedNonce: 6 }));
    await expect(service.withdraw(request, 'withdrawal-test-001')).rejects.toMatchObject({ code: 'WALLET_PENDING' });
    expect(sign).not.toHaveBeenCalled();
  });
});
