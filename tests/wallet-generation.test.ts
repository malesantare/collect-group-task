import { isAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { generateWallets } from '../src/blockchain/wallets.js';
import { EXPECTED_ADDRESSES, TEST_MNEMONIC } from './fixtures/mnemonic.js';

describe('wallet generation', () => {
  it('matches known addresses for the indexed Ethereum derivation path', () => {
    expect(generateWallets(TEST_MNEMONIC, 3).map((wallet) => wallet.address))
      .toEqual(EXPECTED_ADDRESSES);
  });

  it('preserves index and order across independent runs and 3 -> 5 -> 2 -> 5', () => {
    const initial = generateWallets(TEST_MNEMONIC, 3);
    expect(generateWallets(TEST_MNEMONIC, 3)).toEqual(initial);
    const expanded = generateWallets(TEST_MNEMONIC, 5);
    expect(expanded.slice(0, 3)).toEqual(initial);
    expect(generateWallets(TEST_MNEMONIC, 2)).toEqual(initial.slice(0, 2));
    expect(generateWallets(TEST_MNEMONIC, 5)).toEqual(expanded);
  });

  it.each([1, 20])('generates %i distinct addresses in index order', (count) => {
    const wallets = generateWallets(TEST_MNEMONIC, count);
    expect(wallets).toHaveLength(count);
    expect(new Set(wallets.map((wallet) => wallet.address)).size).toBe(count);
    wallets.forEach((wallet, index) => {
      expect(wallet.index).toBe(index);
      expect(isAddress(wallet.address)).toBe(true);
    });
  });

  it.each([0, 21, -1, 1.5, NaN, Infinity])('rejects invalid count %s', (count) => {
    expect(() => generateWallets(TEST_MNEMONIC, count)).toThrow('Wallet count');
  });

  it.each(['', 'not a valid phrase', Array(12).fill('abandon').join(' ')])(
    'rejects missing words or an invalid checksum', (phrase) => {
      expect(() => generateWallets(phrase, 1)).toThrow(
        'Invalid MNEMONIC: expected a valid English BIP-39 phrase.',
      );
    },
  );

  it('normalizes whitespace without changing addresses', () => {
    expect(generateWallets(`  ${TEST_MNEMONIC.replaceAll(' ', '\t\n')}  `, 3))
      .toEqual(generateWallets(TEST_MNEMONIC, 3));
  });

  it('uses the configured mnemonic instead of hardcoded wallet addresses', () => {
    const another = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(generateWallets(another, 1)[0]?.address).not.toBe(EXPECTED_ADDRESSES[0]);
  });

  it('returns only public data suitable for serialization', () => {
    const wallets = generateWallets(TEST_MNEMONIC, 3);
    expect(JSON.parse(JSON.stringify(wallets))).toEqual(
      EXPECTED_ADDRESSES.map((address, index) => ({ index, address })),
    );
  });
});
