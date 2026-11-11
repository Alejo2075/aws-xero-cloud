// Shared helper: map workspace package names -> src entrypoints (used by vitest aliases).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function workspaceAliases(root) {
  const aliases = {};
  for (const dir of ['packages', 'apps']) {
    const base = resolve(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pj = join(base, name, 'package.json');
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      const entry = join(base, name, 'src', 'index.ts');
      if (existsSync(entry)) aliases[pkg.name] = entry;
    }
  }
  return aliases;
}
