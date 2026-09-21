import { describe, expect, it, vi } from 'vitest';
import { SepoliaBalanceSource, WrongNetworkError } from '../src/blockchain/balances.js';
import { BalanceService } from '../src/balances/service.js';
import { EXPECTED_ADDRESSES } from './fixtures/mnemonic.js';

const hash = `0x${'a'.repeat(64)}`;
const wallets = [{ index: 0, address: EXPECTED_ADDRESSES[0]! }, { index: 1, address: EXPECTED_ADDRESSES[1]! }];
function transport() {
  return { send: vi.fn(async (method: string, _params: unknown[]): Promise<unknown> => {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash };
    if (method === 'eth_getBalance') return '0x26e2679d24c5306';
    throw new Error('Unexpected RPC request');
  }) };
}

describe('Sepolia balance source', () => {
  it('pins all balances to one block, checks the block hash, and rechecks the chain', async () => {
    const rpc = transport();
    const snapshot = await new SepoliaBalanceSource(rpc).readSnapshot(wallets);
    expect(snapshot.blockNumber).toBe(100);
    expect(snapshot.blockHash).toBe(hash);
    expect(snapshot.balances[0]?.balanceWei).toBe(BigInt('0x26e2679d24c5306'));
    expect(rpc.send.mock.calls.filter(([method]) => method === 'eth_getBalance'))
      .toEqual(wallets.map((wallet) => ['eth_getBalance', [wallet.address, '0x64']]));
    expect(rpc.send.mock.calls.at(-1)).toEqual(['eth_chainId', []]);
    expect(rpc.send).toHaveBeenCalledWith('eth_getBlockByNumber', ['0x64', false]);
  });

  it('rejects mainnet before reading balances or saving anything', async () => {
    const rpc = transport();
    rpc.send.mockResolvedValue('0x1');
    const store = { applySnapshot: vi.fn() };
    await expect(new BalanceService(wallets, new SepoliaBalanceSource(rpc), store).refresh())
      .rejects.toBeInstanceOf(WrongNetworkError);
    expect(rpc.send).toHaveBeenCalledTimes(1);
    expect(store.applySnapshot).not.toHaveBeenCalled();
  });

  it('does not save a partial snapshot if one RPC call fails', async () => {
    const rpc = transport();
    const original = rpc.send.getMockImplementation()!;
    rpc.send.mockImplementation(async (method, params) => {
      if (method === 'eth_getBalance' && params[0] === wallets[1]!.address) throw new Error('timeout');
      return original(method, params);
    });
    const store = { applySnapshot: vi.fn() };
    await expect(new BalanceService(wallets, new SepoliaBalanceSource(rpc), store).refresh()).rejects.toThrow();
    expect(store.applySnapshot).not.toHaveBeenCalled();
  });

  it('discards balances if the pinned block was reorganized during the reads', async () => {
    const rpc = transport();
    const original = rpc.send.getMockImplementation()!;
    rpc.send.mockImplementation(async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === '0x64') return { number: '0x64', hash: `0x${'b'.repeat(64)}` };
      return original(method, params);
    });
    await expect(new SepoliaBalanceSource(rpc).readSnapshot(wallets)).rejects.toThrow('Block changed');
  });

  it('rejects malformed amounts instead of treating them as zero', async () => {
    const rpc = transport();
    const original = rpc.send.getMockImplementation()!;
    rpc.send.mockImplementation(async (method, params) => method === 'eth_getBalance' ? null : original(method, params));
    await expect(new SepoliaBalanceSource(rpc).readSnapshot(wallets)).rejects.toThrow();
  });
});
