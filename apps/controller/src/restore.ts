import { copyFileSync, existsSync, renameSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { XeroError } from '@xero/core';
import { SqliteRegistry } from '@xero/registry';

/**
 * Offline restore of a registry snapshot taken with `xero backup`. The controller must be stopped.
 * The current database is kept as `xero.db.pre-restore`. Refuses snapshots from a newer schema.
 */
export function restoreBackup(home: string, backupFile: string): { previous: string | undefined } {
  if (!existsSync(backupFile)) throw new XeroError('INVALID_REQUEST', 'backup file not found');
  // Opening validates it is a Xero database and runs/rejects migrations (STATE_INCOMPATIBLE if newer).
  new SqliteRegistry(backupFile).close();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = join(home, 'xero.db');
  let previous: string | undefined;
  if (existsSync(target)) {
    previous = `${target}.pre-restore`;
    renameSync(target, previous);
  }
  for (const ext of ['-wal', '-shm']) rmSync(`${target}${ext}`, { force: true });
  copyFileSync(backupFile, target);
  chmodSync(target, 0o600);
  return { previous };
}
