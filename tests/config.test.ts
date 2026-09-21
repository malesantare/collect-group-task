import { describe, expect, it } from 'vitest';
import { loadConfig, loadRuntimeConfig, loadWithdrawalApiKey } from '../src/config/env.js';
import { TEST_MNEMONIC } from './fixtures/mnemonic.js';

const baseEnv = { MNEMONIC: TEST_MNEMONIC };

describe('configuration boundary', () => {
  it('starts with local defaults and a testnet target', () => {
    expect(loadConfig(baseEnv)).toEqual({
      host: '127.0.0.1', port: 3000, walletCount: 5, chainId: 11155111,
      mnemonic: TEST_MNEMONIC,
    });
  });

  it.each(['1', '20'])('accepts wallet-count boundary %s', (value) => {
    expect(loadConfig({ ...baseEnv, WALLET_COUNT: value }).walletCount).toBe(Number(value));
  });

  it.each(['0', '21', '-1', '1.5', '', ' ', '2abc', '1e1'])('rejects invalid wallet count %j', (value) => {
    expect(() => loadConfig({ ...baseEnv, WALLET_COUNT: value })).toThrow('WALLET_COUNT');
  });

  it.each(['0', '65536', '3.5', 'abc'])('rejects invalid port %s', (value) => {
    expect(() => loadConfig({ ...baseEnv, PORT: value })).toThrow('PORT');
  });

  it.each(['1', '56', ''])('rejects another chain or an empty chain ID: %j', (value) => {
    expect(() => loadConfig({ ...baseEnv, CHAIN_ID: value })).toThrow('CHAIN_ID');
  });

  it('does not expose environment values in configuration errors', () => {
    const secret = 'private-value-that-must-not-be-logged';
    expect(() => loadConfig({ ...baseEnv, HOST: secret })).toThrow('HOST');
    try {
      loadConfig({ ...baseEnv, HOST: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('fails when MNEMONIC is missing instead of creating new wallets', () => {
    expect(() => loadConfig({})).toThrow('Invalid configuration: MNEMONIC.');
  });

  it.each(['', 'secret invalid phrase', Array(12).fill('abandon').join(' ')])(
    'rejects invalid mnemonic without exposing its value', (mnemonic) => {
      expect(() => loadConfig({ MNEMONIC: mnemonic })).toThrow(
        'Invalid configuration: MNEMONIC. Check .env.example.',
      );
    },
  );
});

describe('balance runtime configuration', () => {
  const env = { ...baseEnv, DATABASE_URL: 'postgresql://test:test@127.0.0.1/test' };
  it('uses a one-minute poll interval and a bounded RPC timeout', () => {
    expect(loadRuntimeConfig(env)).toMatchObject({ pollIntervalMs: 60000, rpcTimeoutMs: 10000 });
  });
  it.each(['0', '60001', '1000.5'])('rejects invalid polling interval %s', (value) => {
    expect(() => loadRuntimeConfig({ ...env, POLL_INTERVAL_MS: value })).toThrow('POLL_INTERVAL_MS');
  });
  it('rejects missing database settings without affecting offline wallet listing', () => {
    expect(() => loadRuntimeConfig(baseEnv)).toThrow('DATABASE_URL');
    expect(() => loadConfig(baseEnv)).not.toThrow();
  });
  it('rejects unsupported RPC and database protocols', () => {
    expect(() => loadRuntimeConfig({ ...env, RPC_URL: 'file:///private' })).toThrow('RPC_URL');
    expect(() => loadRuntimeConfig({ ...env, DATABASE_URL: 'https://private' })).toThrow('DATABASE_URL');
  });
});

it('requires a sufficiently long withdrawal API key without echoing it on failure', () => {
  expect(() => loadWithdrawalApiKey({})).toThrow('WITHDRAWAL_API_KEY');
  expect(() => loadWithdrawalApiKey({ WITHDRAWAL_API_KEY: 'short-secret' })).toThrow(
    'Invalid configuration: WITHDRAWAL_API_KEY. Check .env.example.',
  );
  expect(loadWithdrawalApiKey({ WITHDRAWAL_API_KEY: 'a'.repeat(64) })).toBe('a'.repeat(64));
});
