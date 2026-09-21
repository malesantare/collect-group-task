import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Mnemonic } from 'ethers';

export async function initializeTestEnvironment(path: string): Promise<void> {
  const phrase = Mnemonic.fromEntropy(randomBytes(16)).phrase;
  const contents = [
    '# Local test-only wallets. Keep this file to retain the same addresses.',
    'HOST=127.0.0.1',
    'PORT=3000',
    'WALLET_COUNT=5',
    'CHAIN_ID=11155111',
    `MNEMONIC="${phrase}"`,
    '',
  ].join('\n');

  try {
    // Exclusive creation prevents replacing existing wallets, including on reruns.
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('.env already exists. Existing configuration was preserved.');
    }
    throw new Error('Could not create .env. Check directory permissions.');
  }
}
