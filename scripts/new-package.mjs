#!/usr/bin/env node
// Usage: node scripts/new-package.mjs <packages|apps> <dir> "<description>" [--dep name@range]... [--bin name=path]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [kind, dir, description, ...rest] = process.argv.slice(2);
const deps = {};
const workspaceRefs = [];
let bin;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--dep') {
    const spec = rest[++i];
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    const range = spec.slice(at + 1);
    if (range === 'workspace') {
      deps[name] = 'workspace:*';
      workspaceRefs.push(name.replace(/^@xero\//, ''));
    } else deps[name] = range;
  } else if (rest[i] === '--bin') {
    const [n, p] = rest[++i].split('=');
    bin = { [n]: p };
  }
}
const root = process.cwd();
const base = join(root, kind, dir);
mkdirSync(join(base, 'src'), { recursive: true });
mkdirSync(join(base, 'test'), { recursive: true });
const pkg = {
  name: kind === 'apps' ? `@xero/${dir}` : `@xero/${dir}`,
  version: '0.1.0',
  description,
  license: 'Apache-2.0',
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  files: ['dist'],
  ...(bin ? { bin } : {}),
  dependencies: deps,
};
writeFileSync(join(base, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const refs = workspaceRefs.map((r) => ({ path: kind === 'apps' ? `../../packages/${r}` : `../${r}` }));
// refs may point to apps? only packages are referenced.
writeFileSync(
  join(base, 'tsconfig.json'),
  JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'dist' }, include: ['src'], references: refs }, null, 2) + '\n',
);
const rootTs = join(root, 'tsconfig.json');
const ts = JSON.parse(readFileSync(rootTs, 'utf8'));
const p = `./${kind}/${dir}`;
if (!ts.references.some((r) => r.path === p)) ts.references.push({ path: p });
writeFileSync(rootTs, JSON.stringify(ts, null, 2) + '\n');
if (!existsSync(join(base, 'src', 'index.ts'))) writeFileSync(join(base, 'src', 'index.ts'), 'export {};\n');
console.log('created', p);
