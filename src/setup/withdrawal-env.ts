import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export async function initializeWithdrawalEnvironment(path: string): Promise<boolean> {
  const env = parseEnv(await readFile(path, 'utf8'));
  if (env.WITHDRAWAL_API_KEY) return false;
  await appendFile(path, `\nWITHDRAWAL_API_KEY=${randomBytes(32).toString('hex')}\n`, 'utf8');
  return true;
}
