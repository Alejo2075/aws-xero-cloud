import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { manifestSchema, type FunctionManifest } from '@xero/specification';

export class CliUsageError extends Error {
  override readonly name = 'CliUsageError';
}

export interface LoadedManifest {
  manifest: FunctionManifest;
  /** Directory of the manifest file; relative artifact paths resolve against it. */
  dir: string;
}

/** Loads `xero.yaml` / `xero.yml` / `xero.json` from a function directory, if present. */
export async function loadManifest(dir: string): Promise<LoadedManifest | undefined> {
  for (const name of ['xero.yaml', 'xero.yml', 'xero.json']) {
    const path = join(dir, name);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    let doc: unknown;
    try {
      doc = name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    } catch (e) {
      throw new CliUsageError(`${name}: cannot parse (${e instanceof Error ? e.message : String(e)})`);
    }
    const parsed = manifestSchema.safeParse(doc);
    if (!parsed.success) {
      throw new CliUsageError(`${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    }
    return { manifest: parsed.data, dir };
  }
  return undefined;
}

/** Best-effort inference when there is no manifest and no flags. Never guesses silently: flags always win. */
export async function inferRuntime(dir: string): Promise<{ runtime: 'nodejs22.x' | 'python3.13'; handler: string } | undefined> {
  const has = (f: string): Promise<boolean> => stat(join(dir, f)).then(() => true, () => false);
  if ((await has('index.js')) || (await has('index.mjs')) || (await has('index.cjs'))) return { runtime: 'nodejs22.x', handler: 'index.handler' };
  if (await has('lambda_function.py')) return { runtime: 'python3.13', handler: 'lambda_function.lambda_handler' };
  if (await has('app.py')) return { runtime: 'python3.13', handler: 'app.handler' };
  return undefined;
}

export function defaultName(dir: string): string {
  return basename(resolve(dir)).replace(/[^a-zA-Z0-9-_]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 64);
}
