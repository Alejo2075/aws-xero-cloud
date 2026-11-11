import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { XeroError, type ArtifactRef, type ArtifactStore } from '@xero/core';

export interface ArtifactLimits {
  maxBytes: number;
  maxFiles: number;
  maxPathLength: number;
}
export const DEFAULT_LIMITS: ArtifactLimits = {
  maxBytes: 250 * 1024 * 1024, // matches Lambda's unzipped deployment package limit
  maxFiles: 20_000,
  maxPathLength: 512,
};

const DEFAULT_EXCLUDES = new Set(['.git', '.xero', '.DS_Store']);
const ID_RE = /^sha256:([0-9a-f]{64})$/;

interface Entry {
  rel: string; // posix relative path
  kind: 'file' | 'dir' | 'symlink';
  mode: number;
  linkTarget?: string;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Deterministic content hash of a directory tree (paths, exec bit, content, relative symlink targets). */
export async function hashTree(root: string): Promise<string> {
  const lines: string[] = [];
  async function walk(dir: string, relDir: string): Promise<void> {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const abs = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const st = await lstat(abs);
      if (st.isSymbolicLink()) lines.push(`L\0${rel}\0${await readlink(abs)}`);
      else if (st.isDirectory()) {
        lines.push(`D\0${rel}`);
        await walk(abs, rel);
      } else if (st.isFile()) lines.push(`F\0${rel}\0${st.mode & 0o111 ? 'x' : '-'}\0${await sha256File(abs)}`);
    }
  }
  await walk(root, '');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export class DirectoryArtifactStore implements ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly limits: ArtifactLimits = DEFAULT_LIMITS,
  ) {}

  pathOf(artifactId: string): string {
    const m = ID_RE.exec(artifactId);
    if (!m) throw new XeroError('ARTIFACT_INVALID', 'malformed artifact id');
    return join(this.root, m[1]!);
  }

  async ingest(sourceDir: string): Promise<ArtifactRef> {
    let source: string;
    try {
      source = await realpath(resolve(sourceDir));
      if (!(await stat(source)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new XeroError('ARTIFACT_INVALID', 'artifact source must be an existing directory');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const tmp = join(this.root, `.tmp-${randomBytes(8).toString('hex')}`);
    await mkdir(tmp, { recursive: true });
    try {
      const entries = await this.collect(source);
      let bytes = 0;
      let files = 0;
      for (const e of entries) {
        const dest = join(tmp, ...e.rel.split('/'));
        if (e.kind === 'dir') await mkdir(dest, { recursive: true });
        else if (e.kind === 'symlink') {
          await mkdir(dirname(dest), { recursive: true });
          await symlink(e.linkTarget!, dest);
        } else {
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(join(source, ...e.rel.split('/')), dest);
          files += 1;
          bytes += (await stat(dest)).size;
          if (bytes > this.limits.maxBytes) throw new XeroError('ARTIFACT_TOO_LARGE', `artifact exceeds ${this.limits.maxBytes} bytes`);
        }
      }
      if (files === 0) throw new XeroError('ARTIFACT_INVALID', 'artifact contains no files');
      const hex = await hashTree(tmp);
      const final = join(this.root, hex);
      let exists = false;
      try {
        await stat(final);
        exists = true;
      } catch {
        /* not yet stored */
      }
      if (exists) await this.makeWritable(tmp).then(() => rm(tmp, { recursive: true, force: true }));
      else {
        await this.seal(tmp, entries);
        await rename(tmp, final);
      }
      return { id: `sha256:${hex}`, sizeBytes: bytes, fileCount: files };
    } catch (e) {
      await this.makeWritable(tmp).catch(() => undefined);
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  async verify(artifactId: string): Promise<boolean> {
    return (await hashTree(this.pathOf(artifactId))) === ID_RE.exec(artifactId)![1];
  }

  async remove(artifactId: string): Promise<void> {
    const p = this.pathOf(artifactId);
    await this.makeWritable(p).catch(() => undefined);
    await rm(p, { recursive: true, force: true });
  }

  private async collect(source: string): Promise<Entry[]> {
    const out: Entry[] = [];
    const limits = this.limits;
    async function walk(dir: string, relDir: string): Promise<void> {
      for (const name of (await readdir(dir)).sort()) {
        if (!relDir && DEFAULT_EXCLUDES.has(name)) continue;
        if (name === '.DS_Store') continue;
        const abs = join(dir, name);
        const rel = relDir ? `${relDir}/${name}` : name;
        if (rel.length > limits.maxPathLength) throw new XeroError('ARTIFACT_INVALID', `path too long: ${rel.slice(0, 80)}…`);
        const st = await lstat(abs);
        if (out.length >= limits.maxFiles) throw new XeroError('ARTIFACT_TOO_LARGE', `artifact exceeds ${limits.maxFiles} entries`);
        if (st.isSymbolicLink()) {
          const target = await readlink(abs);
          const resolved = normalize(join(dirname(abs), target));
          const inside = !isAbsolute(target) && (resolved === source || resolved.startsWith(source + sep));
          if (!inside || relative(source, resolved).startsWith('..')) {
            throw new XeroError('ARTIFACT_INVALID', `symlink escapes the artifact root: ${rel}`);
          }
          out.push({ rel, kind: 'symlink', mode: 0o777, linkTarget: target });
        } else if (st.isDirectory()) {
          out.push({ rel, kind: 'dir', mode: st.mode });
          await walk(abs, rel);
        } else if (st.isFile()) {
          out.push({ rel, kind: 'file', mode: st.mode });
        } else {
          throw new XeroError('ARTIFACT_INVALID', `unsupported file type (device/socket/fifo): ${rel}`);
        }
      }
    }
    await walk(source, '');
    return out;
  }

  /** Make the stored tree read-only (files 0444/0555, dirs 0555). */
  private async seal(dir: string, entries: Entry[]): Promise<void> {
    for (const e of entries) {
      if (e.kind === 'symlink') continue;
      const p = join(dir, ...e.rel.split('/'));
      if (e.kind === 'file') await chmod(p, e.mode & 0o111 ? 0o555 : 0o444);
    }
    for (const e of [...entries].reverse()) if (e.kind === 'dir') await chmod(join(dir, ...e.rel.split('/')), 0o555);
    await chmod(dir, 0o555);
  }

  private async makeWritable(dir: string): Promise<void> {
    await chmod(dir, 0o755);
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const st = await lstat(p);
      if (st.isDirectory()) await this.makeWritable(p);
    }
  }
}
