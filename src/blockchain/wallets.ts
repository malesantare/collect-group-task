import { HDNodeWallet, Mnemonic } from 'ethers';

export const WALLET_BRANCH_PATH = "m/44'/60'/0'/0";

export interface WalletAddress {
  readonly index: number;
  readonly address: string;
}

export function normalizeMnemonic(phrase: string): string {
  return phrase.normalize('NFKD').trim().replace(/\s+/gu, ' ');
}

export function generateWallets(phrase: string, count: number): readonly WalletAddress[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error('Wallet count must be an integer between 1 and 20.');
  }

  const mnemonic = normalizeMnemonic(phrase);
  if (!Mnemonic.isValidMnemonic(mnemonic)) {
    // ethers errors may include the rejected input; keep it out of our errors.
    throw new Error('Invalid MNEMONIC: expected a valid English BIP-39 phrase.');
  }

  // Explicit branch, then its children: m/44'/60'/0'/0/i.
  // Empty BIP-39 passphrase is intentional and part of the derivation contract.
  const branch = HDNodeWallet.fromPhrase(mnemonic, '', WALLET_BRANCH_PATH);
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const wallet = branch.deriveChild(index);
    // Never return ethers wallet instances: they contain private key material.
    return Object.freeze({ index, address: wallet.address });
  }));
}
