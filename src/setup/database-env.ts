import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export async function initializeDatabaseEnvironment(path: string): Promise<boolean> {
  const contents = await readFile(path, 'utf8');
  const env = parseEnv(contents);
  if (env.DATABASE_URL) return false;
  const password = env.POSTGRES_PASSWORD || randomBytes(24).toString('hex');
  const port = env.POSTGRES_PORT || '55432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Invalid POSTGRES_PORT.');
  }
  const lines = [''];
  if (!env.POSTGRES_PASSWORD) lines.push(`POSTGRES_PASSWORD=${password}`);
  lines.push(`DATABASE_URL=postgresql://wallet_watcher:${encodeURIComponent(password)}@127.0.0.1:${port}/wallet_watcher`, '');
  // Append DB settings only. Never replace MNEMONIC or other existing settings.
  await appendFile(path, lines.join('\n'), 'utf8');
  return true;
}
