import { getAddress, HDNodeWallet, Mnemonic, Transaction, ZeroAddress } from 'ethers';
import { normalizeMnemonic, WALLET_BRANCH_PATH } from './wallets.js';
import { WithdrawalError } from '../withdrawals/errors.js';

export interface TransactionInput {
  from: string;
  to: string;
  value: bigint;
  chainId: bigint;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export function buildTransaction(input: TransactionInput) {
  if (input.chainId !== 11155111n) throw new WithdrawalError('WRONG_NETWORK', 'Only Sepolia transactions may be signed.', 422);
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0 || input.value <= 0n || input.value >= 2n ** 256n
    || input.gasLimit < 21000n || input.gasLimit >= 2n ** 64n || input.maxPriorityFeePerGas < 0n
    || input.maxFeePerGas <= 0n || input.maxFeePerGas >= 2n ** 256n || input.maxPriorityFeePerGas > input.maxFeePerGas) {
    throw new WithdrawalError('INVALID_TRANSACTION', 'Invalid transaction amount, nonce, gas limit, or fees.', 422);
  }
  const from = getAddress(input.from);
  const to = getAddress(input.to);
  if (to === ZeroAddress) throw new WithdrawalError('INVALID_DESTINATION', 'Zero-address transfers are not supported.', 400);
  return { ...input, from, to, type: 2 as const, data: '0x', accessList: [] };
}

export function describeSignedTransaction(serialized: string) {
  const tx = Transaction.from(serialized);
  if (tx.chainId !== 11155111n || tx.type !== 2 || !tx.from || !tx.to || !tx.signature || !tx.hash
    || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null || tx.data !== '0x') {
    throw new Error('Invalid signed Sepolia ETH transaction.');
  }
  return {
    payload: {
      type: 2, chainId: 11155111, from: tx.from, to: tx.to, value: tx.value.toString(),
      nonce: tx.nonce, gasLimit: tx.gasLimit.toString(), maxFeePerGas: tx.maxFeePerGas.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(), data: tx.data, accessList: tx.accessList,
    },
    unsignedTransaction: tx.unsignedSerialized,
    signature: { r: tx.signature.r, s: tx.signature.s, yParity: tx.signature.yParity },
    signedTransaction: serialized,
    transactionHash: tx.hash,
    maxFeeWei: (tx.gasLimit * tx.maxFeePerGas).toString(),
  };
}

export type SignedTransaction = ReturnType<typeof describeSignedTransaction>;
export interface TransactionSigner {
  sign(index: number, input: TransactionInput): Promise<SignedTransaction>;
}

export class HdTransactionSigner implements TransactionSigner {
  readonly #branch: HDNodeWallet;
  readonly #count: number;
  constructor(phrase: string, count: number) {
    const mnemonic = normalizeMnemonic(phrase);
    if (!Mnemonic.isValidMnemonic(mnemonic) || !Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error('Invalid signing configuration.');
    }
    this.#branch = HDNodeWallet.fromPhrase(mnemonic, '', WALLET_BRANCH_PATH);
    this.#count = count;
  }

  async sign(index: number, input: TransactionInput): Promise<SignedTransaction> {
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) {
      throw new WithdrawalError('WALLET_NOT_FOUND', 'Wallet is not active.', 404);
    }
    const transaction = buildTransaction(input);
    const wallet = this.#branch.deriveChild(index);
    if (wallet.address !== transaction.from) throw new Error('Signer does not match the selected wallet.');
    // The wallet has no provider: this operation cannot broadcast a transaction.
    return describeSignedTransaction(await wallet.signTransaction(transaction));
  }
}
