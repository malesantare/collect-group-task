import { describe, expect, it } from 'vitest';
import { parseWithdrawalRequest } from '../src/withdrawals/request.js';
import { EXPECTED_ADDRESSES } from './fixtures/mnemonic.js';

const input = { walletIndex: 0, to: EXPECTED_ADDRESSES[1]!, amount: '0.000000000000000001' };
describe('withdrawal request validation', () => {
  it('accepts exactly one wei and defaults to no broadcast', () => {
    expect(parseWithdrawalRequest(input, 3)).toMatchObject({ value: 1n, broadcast: false });
  });
  it.each([0.1, '0', '-1', '1e-3', 'NaN', ' 1', '0.0000000000000000001', '9'.repeat(80)])(
    'rejects an invalid or imprecise amount: %s', (amount) => {
      expect(() => parseWithdrawalRequest({ ...input, amount }, 3)).toThrow();
    },
  );
  it.each([
    { to: 'alice.eth' }, { to: '0x0000000000000000000000000000000000000000' },
    { walletIndex: 3 }, { walletIndex: 0.5 }, { broadcast: 'false' }, { nonce: 10 }, { chainId: 1 }, { data: '0x1234' },
  ])('rejects invalid identity, flags, or user-controlled transaction fields: %j', (override) => {
    expect(() => parseWithdrawalRequest({ ...input, ...override }, 3)).toThrow();
  });
});
