import { lstatSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectoryArtifactStore } from '../src/index.js';

let work: string;
let store: DirectoryArtifactStore;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'xero-art-'));
  mkdirSync(join(work, 'src'));
  store = new DirectoryArtifactStore(join(work, 'store'), { maxBytes: 1000, maxFiles: 20, maxPathLength: 100 });
});
afterEach(() => {
  try { chmodRecursive(join(work, 'store')); } catch { /* ignore */ }
  rmSync(work, { recursive: true, force: true });
});
function chmodRecursive(p: string): void {
  if (!existsSync(p)) return;
  chmodSync(p, 0o755);
  for (const name of readdirSync(p)) {
    const c = join(p, name);
    if (lstatSync(c).isDirectory()) chmodRecursive(c);
  }
}
const write = (rel: string, content: string): void => {
  mkdirSync(join(work, 'src', rel, '..'), { recursive: true });
  writeFileSync(join(work, 'src', rel), content);
};

describe('DirectoryArtifactStore', () => {
  it('ingests a directory content-addressed and read-only', async () => {
    write('index.js', 'exports.handler = async () => 1;');
    write('lib/util.js', 'module.exports = 1');
    const ref = await store.ingest(join(work, 'src'));
    expect(ref.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.fileCount).toBe(2);
    const p = store.pathOf(ref.id);
    expect(readFileSync(join(p, 'index.js'), 'utf8')).toContain('handler');
    expect(statSync(join(p, 'index.js')).mode & 0o222).toBe(0);
    expect(await store.verify(ref.id)).toBe(true);
  });

  it('is deterministic and deduplicates identical content', async () => {
    write('a.js', 'x');
    const a = await store.ingest(join(work, 'src'));
    const b = await store.ingest(join(work, 'src'));
    expect(b.id).toBe(a.id);
    write('a.js', 'y');
    const c = await store.ingest(join(work, 'src'));
    expect(c.id).not.toBe(a.id);
  });

  it('is immutable: later edits of the source do not change the stored artifact', async () => {
    write('a.js', 'v1');
    const a = await store.ingest(join(work, 'src'));
    write('a.js', 'v2');
    expect(readFileSync(join(store.pathOf(a.id), 'a.js'), 'utf8')).toBe('v1');
  });

  it('rejects symlinks that escape the root and absolute links', async () => {
    write('a.js', 'x');
    symlinkSync('/etc/passwd', join(work, 'src', 'abs'));
    await expect(store.ingest(join(work, 'src'))).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    rmSync(join(work, 'src', 'abs'));
    symlinkSync('../outside', join(work, 'src', 'esc'));
    await expect(store.ingest(join(work, 'src'))).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('allows relative symlinks that stay inside', async () => {
    write('a.js', 'x');
    symlinkSync('a.js', join(work, 'src', 'link.js'));
    const ref = await store.ingest(join(work, 'src'));
    expect(ref.fileCount).toBe(1);
  });

  it('enforces size, file count, path length and emptiness; leaves no temp dirs', async () => {
    write('big.bin', 'x'.repeat(1001));
    await expect(store.ingest(join(work, 'src'))).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE' });
    rmSync(join(work, 'src', 'big.bin'));
    await expect(store.ingest(join(work, 'src'))).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    for (let i = 0; i < 25; i++) write(`f${i}`, 'x');
    await expect(store.ingest(join(work, 'src'))).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE' });
    await expect(store.ingest(join(work, 'nope'))).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('skips .git and removes artifacts', async () => {
    write('a.js', 'x');
    mkdirSync(join(work, 'src', '.git'));
    writeFileSync(join(work, 'src', '.git', 'config'), 'secret');
    const ref = await store.ingest(join(work, 'src'));
    expect(existsSync(join(store.pathOf(ref.id), '.git'))).toBe(false);
    await store.remove(ref.id);
    expect(existsSync(store.pathOf(ref.id))).toBe(false);
  });

  it('rejects malformed artifact ids (path traversal)', () => {
    expect(() => store.pathOf('sha256:../../etc')).toThrow();
  });
});
