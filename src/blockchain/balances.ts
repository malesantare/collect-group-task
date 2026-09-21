import { FetchRequest, JsonRpcProvider } from 'ethers';
import type { WalletAddress } from './wallets.js';
import type { BalanceSnapshot, BalanceSource } from '../balances/types.js';

export interface RpcTransport {
  send(method: string, params: unknown[]): Promise<unknown>;
}

export class WrongNetworkError extends Error {
  constructor() {
    super('RPC network is not Sepolia (11155111). No balances were saved.');
    this.name = 'WrongNetworkError';
  }
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid RPC quantity.');
  return BigInt(value);
}

function block(value: unknown): { number: number; hash: string } {
  if (!value || typeof value !== 'object') throw new Error('RPC block unavailable.');
  const raw = value as Record<string, unknown>;
  const number = Number(quantity(raw.number));
  if (!Number.isSafeInteger(number) || typeof raw.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(raw.hash)) {
    throw new Error('Invalid RPC block.');
  }
  return { number, hash: raw.hash.toLowerCase() };
}

export function createRpcProvider(url: string, timeoutMs: number): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  // The poller retries the complete snapshot on its next cycle.
  request.retryFunc = async () => false;
  return new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
}

export class SepoliaBalanceSource implements BalanceSource {
  constructor(private readonly rpc: RpcTransport) {}

  async assertNetwork(): Promise<void> {
    if (quantity(await this.rpc.send('eth_chainId', [])) !== 11155111n) throw new WrongNetworkError();
  }

  async readSnapshot(wallets: readonly WalletAddress[]): Promise<BalanceSnapshot> {
    await this.assertNetwork();
    const initial = block(await this.rpc.send('eth_getBlockByNumber', ['latest', false]));
    const tag = `0x${initial.number.toString(16)}`;
    const balances: BalanceSnapshot['balances'] = [];
    for (let offset = 0; offset < wallets.length; offset += 5) {
      const results = await Promise.allSettled(wallets.slice(offset, offset + 5).map(async (wallet) => {
        const balanceWei = quantity(await this.rpc.send('eth_getBalance', [wallet.address, tag]));
        if (balanceWei >= 2n ** 256n) throw new Error('Invalid RPC balance.');
        return { ...wallet, balanceWei };
      }));
      for (const result of results) {
        if (result.status === 'rejected') throw new Error('Could not read a complete balance snapshot.');
        balances.push(result.value);
      }
    }
    const final = block(await this.rpc.send('eth_getBlockByNumber', [tag, false]));
    if (initial.number !== final.number || initial.hash !== final.hash) throw new Error('Block changed during balance refresh.');
    await this.assertNetwork();
    return { blockNumber: initial.number, blockHash: initial.hash, observedAt: new Date(), balances };
  }
}
