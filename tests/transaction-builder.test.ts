import { keccak256, recoverAddress, Transaction } from 'ethers';
import { describe, expect, it } from 'vitest';
import { buildTransaction, HdTransactionSigner, type TransactionInput } from '../src/blockchain/transaction.js';
import { TEST_MNEMONIC, EXPECTED_ADDRESSES } from './fixtures/mnemonic.js';

const input: TransactionInput = {
  from: EXPECTED_ADDRESSES[2]!, to: EXPECTED_ADDRESSES[0]!, value: 100000000000000001n,
  chainId: 11155111n, nonce: 7, gasLimit: 21000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n,
};

describe('transaction construction and signing', () => {
  it('recovers the selected indexed wallet and verifies all fields from signed bytes', async () => {
    const signed = await new HdTransactionSigner(TEST_MNEMONIC, 3).sign(2, input);
    const decoded = Transaction.from(signed.signedTransaction);
    expect(decoded.from).toBe(EXPECTED_ADDRESSES[2]);
    expect(decoded.to).toBe(input.to);
    expect(decoded.value).toBe(input.value);
    expect(decoded.chainId).toBe(11155111n);
    expect(decoded.nonce).toBe(7);
    expect(decoded.gasLimit).toBe(21000n);
    expect(decoded.maxFeePerGas).toBe(input.maxFeePerGas);
    expect(decoded.maxPriorityFeePerGas).toBe(input.maxPriorityFeePerGas);
    expect(decoded.type).toBe(2);
    expect(decoded.data).toBe('0x');
    expect(recoverAddress(keccak256(signed.unsignedTransaction), signed.signature)).toBe(EXPECTED_ADDRESSES[2]);
    expect(keccak256(signed.signedTransaction)).toBe(signed.transactionHash);
    expect(signed.payload.value).toBe('100000000000000001');
    expect(signed.maxFeeWei).toBe('42000000000000');
    expect(JSON.stringify(signed)).not.toContain(TEST_MNEMONIC);
    expect(Object.keys(signed).sort()).toEqual([
      'payload', 'unsignedTransaction', 'signature', 'signedTransaction', 'transactionHash', 'maxFeeWei',
    ].sort());
  });

  it('refuses to sign for mainnet', async () => {
    await expect(new HdTransactionSigner(TEST_MNEMONIC, 3).sign(2, { ...input, chainId: 1n })).rejects.toThrow('Only Sepolia');
  });
  it('rejects a claimed sender different from the selected wallet', async () => {
    await expect(new HdTransactionSigner(TEST_MNEMONIC, 3).sign(0, input)).rejects.toThrow('Signer does not match');
  });
  it('rejects a wallet index outside the configured range', async () => {
    await expect(new HdTransactionSigner(TEST_MNEMONIC, 2).sign(2, input)).rejects.toThrow('not active');
  });
  it.each([
    { nonce: -1 }, { nonce: 1.5 }, { gasLimit: 0n }, { value: 0n }, { value: -1n },
    { value: 2n ** 256n }, { maxFeePerGas: 0n }, { maxPriorityFeePerGas: 3000000000n },
  ])('rejects invalid transaction fields (case %#)', (override) => {
    expect(() => buildTransaction({ ...input, ...override })).toThrow();
  });
});
