import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { Mnemonic } from 'ethers';
import { initializeTestEnvironment } from '../src/setup/init-env.js';
import { initializeDatabaseEnvironment } from '../src/setup/database-env.js';
import { initializeWithdrawalEnvironment } from '../src/setup/withdrawal-env.js';

const directories: string[] = [];
async function tempPath() {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-watcher-test-'));
  directories.push(directory);
  return join(directory, '.env');
}
afterEach(async () => {
  // Only directories created by this test's mkdtemp are removed.
  await Promise.all(directories.splice(0).map((directory) => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('wallet-watcher-test-')) {
      throw new Error('Refusing to remove a directory outside the test temporary directory.');
    }
    return rm(target, { recursive: true });
  }));
});

it('creates a valid test mnemonic with Sepolia defaults', async () => {
  const path = await tempPath();
  await initializeTestEnvironment(path);
  const env = parseEnv(await readFile(path, 'utf8'));
  expect(Mnemonic.isValidMnemonic(env.MNEMONIC ?? '')).toBe(true);
  expect(env.CHAIN_ID).toBe('11155111');
  expect(env.WALLET_COUNT).toBe('5');
});

it('preserves the seed and all settings on a repeated setup', async () => {
  const path = await tempPath();
  await initializeTestEnvironment(path);
  const before = await readFile(path, 'utf8');
  await expect(initializeTestEnvironment(path)).rejects.toThrow('already exists');
  expect((await readFile(path, 'utf8')) === before).toBe(true);
});

it('does not overwrite even an existing empty .env', async () => {
  const path = await tempPath();
  await writeFile(path, '');
  await expect(initializeTestEnvironment(path)).rejects.toThrow('already exists');
  expect(await readFile(path, 'utf8')).toBe('');
});

it('adds database settings without changing existing wallet configuration', async () => {
  const path = await tempPath();
  await initializeTestEnvironment(path);
  const before = await readFile(path, 'utf8');
  expect(await initializeDatabaseEnvironment(path)).toBe(true);
  const after = await readFile(path, 'utf8');
  expect(after.startsWith(before)).toBe(true);
  const env = parseEnv(after);
  expect(new URL(env.DATABASE_URL!).protocol).toBe('postgresql:');
  expect(new URL(env.DATABASE_URL!).password === env.POSTGRES_PASSWORD).toBe(true);
  expect(await initializeDatabaseEnvironment(path)).toBe(false);
  expect((await readFile(path, 'utf8')) === after).toBe(true);
});

it('adds a signing API credential once without rotating the mnemonic or existing key', async () => {
  const path = await tempPath();
  await initializeTestEnvironment(path);
  const before = await readFile(path, 'utf8');
  expect(await initializeWithdrawalEnvironment(path)).toBe(true);
  const after = await readFile(path, 'utf8');
  expect(after.startsWith(before)).toBe(true);
  expect(parseEnv(after).WITHDRAWAL_API_KEY?.length).toBe(64);
  expect(await initializeWithdrawalEnvironment(path)).toBe(false);
  expect((await readFile(path, 'utf8')) === after).toBe(true);
});
