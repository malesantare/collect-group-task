import { isIP } from 'node:net';
import { Mnemonic } from 'ethers';
import { z } from 'zod';
import { normalizeMnemonic } from '../blockchain/wallets.js';

const integer = (min: number, max: number, fallback: string) =>
  z.string()
    .regex(/^\d+$/, 'must contain only decimal digits')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .prefault(fallback);

const schema = z.object({
  HOST: z.string()
    .refine((value) => value === 'localhost' || isIP(value) !== 0, 'must be an IP address or localhost')
    .default('127.0.0.1'),
  PORT: integer(1, 65535, '3000'),
  WALLET_COUNT: integer(1, 20, '5'),
  CHAIN_ID: z.literal('11155111').default('11155111'),
  MNEMONIC: z.string().transform(normalizeMnemonic)
    .refine((value) => Mnemonic.isValidMnemonic(value), 'must be a valid English BIP-39 phrase'),
});

export class ConfigurationError extends Error {
  constructor(fields: string[]) {
    // Report field names only: environment values may contain secrets.
    super(`Invalid configuration: ${fields.join(', ')}. Check .env.example.`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigurationError([...new Set(result.error.issues.map((issue) => issue.path.join('.')))]);
  }

  return Object.freeze({
    host: result.data.HOST,
    port: result.data.PORT,
    walletCount: result.data.WALLET_COUNT,
    chainId: Number(result.data.CHAIN_ID),
    mnemonic: result.data.MNEMONIC,
  });
}

const runtimeSchema = z.object({
  DATABASE_URL: z.url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  RPC_URL: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .default('https://ethereum-sepolia-rpc.publicnode.com'),
  POLL_INTERVAL_MS: integer(1000, 60000, '60000'),
  RPC_TIMEOUT_MS: integer(1000, 15000, '10000'),
});

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const base = loadConfig(env);
  const result = runtimeSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigurationError([...new Set(result.error.issues.map((issue) => issue.path.join('.')))]);
  }
  return Object.freeze({
    ...base,
    databaseUrl: result.data.DATABASE_URL,
    rpcUrl: result.data.RPC_URL,
    pollIntervalMs: result.data.POLL_INTERVAL_MS,
    rpcTimeoutMs: result.data.RPC_TIMEOUT_MS,
  });
}

export function loadWithdrawalApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const result = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/).safeParse(env.WITHDRAWAL_API_KEY);
  if (!result.success) throw new ConfigurationError(['WITHDRAWAL_API_KEY']);
  return result.data;
}
