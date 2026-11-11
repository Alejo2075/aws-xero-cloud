import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Creates (once) and returns the local API token. Stored 0600 in the Xero home (itself 0700). */
export async function ensureToken(home: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => undefined);
  const path = join(home, 'token');
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* create below */
  }
  const token = randomBytes(32).toString('hex');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

export function tokenMatches(expected: string, header: string | undefined): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
