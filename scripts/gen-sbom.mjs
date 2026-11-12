#!/usr/bin/env node
// Generates a CycloneDX 1.5 SBOM of the PRODUCTION dependency graph of every workspace package by reading pnpm-lock.yaml
// (no third-party SBOM tool is executed). Dev dependencies are excluded.
// Usage: node scripts/gen-sbom.mjs [--output sbom.cdx.json] [--summary]
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--output');
const output = outIdx >= 0 ? args[outIdx + 1] : undefined;

const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const store = join(root, 'node_modules', '.pnpm');
const storeDirs = existsSync(store) ? readdirSync(store) : [];

const stripPeers = (v) => String(v).replace(/\(.*$/, '');
const purl = (name, version) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

// 1. seeds: production deps of every importer (workspace packages and apps); the root importer's devDependencies are excluded.
const seeds = [];
for (const imp of Object.values(lock.importers ?? {})) {
  for (const group of ['dependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(imp[group] ?? {})) {
      const v = typeof spec === 'string' ? spec : spec.version;
      if (String(v).startsWith('link:')) continue; // workspace package: its own importer is walked separately
      seeds.push([name, v]);
    }
  }
}

// 2. walk snapshots transitively
const seen = new Map(); // key name@version(with peers) -> {name, version}
const edges = new Map(); // purl -> Set(purl)
const walk = (name, rawVersion) => {
  const key = `${name}@${rawVersion}`;
  if (seen.has(key)) return;
  const version = stripPeers(rawVersion);
  seen.set(key, { name, version, key });
  const snap = lock.snapshots?.[key];
  const deps = { ...(snap?.dependencies ?? {}), ...(snap?.optionalDependencies ?? {}) };
  const me = purl(name, version);
  if (!edges.has(me)) edges.set(me, new Set());
  for (const [dn, dv] of Object.entries(deps)) {
    edges.get(me).add(purl(dn, stripPeers(dv)));
    walk(dn, dv);
  }
};
for (const [n, v] of seeds) walk(n, v);

// 3. component details: integrity from the lockfile, license from the installed package.json
const licenseOf = (name, version) => {
  const dir = storeDirs.find((d) => d.startsWith(`${name.replace('/', '+')}@${version}`));
  if (!dir) return undefined;
  try {
    const pj = JSON.parse(readFileSync(join(store, dir, 'node_modules', name, 'package.json'), 'utf8'));
    const l = pj.license ?? pj.licenses;
    if (typeof l === 'string') return l;
    if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(' OR ');
    return l?.type;
  } catch {
    return undefined;
  }
};

const byPurl = new Map();
for (const { name, version } of seen.values()) {
  const id = purl(name, version);
  if (byPurl.has(id)) continue;
  const integrity = lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
  const c = { type: 'library', 'bom-ref': id, name: name.startsWith('@') ? name.split('/')[1] : name, ...(name.startsWith('@') ? { group: name.split('/')[0] } : {}), version, purl: id };
  const lic = licenseOf(name, version);
  if (lic) c.licenses = [/\bOR\b|\bAND\b|\(/.test(lic) ? { expression: lic } : { license: { id: lic } }];
  const m = /^sha512-(.+)$/.exec(integrity ?? '');
  if (m) c.hashes = [{ alg: 'SHA-512', content: Buffer.from(m[1], 'base64').toString('hex') }];
  byPurl.set(id, c);
}
const components = [...byPurl.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

const rootRef = `pkg:generic/${rootPkg.name}@${rootPkg.version}`;
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'xero scripts/gen-sbom.mjs' }] },
    component: { type: 'application', 'bom-ref': rootRef, name: rootPkg.name, version: rootPkg.version, licenses: [{ license: { id: rootPkg.license } }] },
  },
  components,
  dependencies: [
    { ref: rootRef, dependsOn: [...new Set(seeds.map(([n, v]) => purl(n, stripPeers(v))))].sort() },
    ...[...edges.entries()].map(([ref, set]) => ({ ref, dependsOn: [...set].sort() })).sort((a, b) => a.ref.localeCompare(b.ref)),
  ],
};

const json = `${JSON.stringify(bom, null, 2)}\n`;
if (output) writeFileSync(output, json);
const licenses = {};
for (const c of components) for (const l of c.licenses ?? [{ license: { id: 'UNKNOWN' } }]) licenses[l.expression ?? l.license.id] = (licenses[l.expression ?? l.license.id] ?? 0) + 1;
console.error(`components: ${components.length}; licenses: ${JSON.stringify(licenses)}`);
if (!output) process.stdout.write(json);
