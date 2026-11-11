import type { FunctionView, InvocationRecord, LogLine } from '@xero/sdk';

export function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all.map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd()).join('\n');
}

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function renderFunctions(fns: FunctionView[]): string {
  if (fns.length === 0) return 'No functions deployed.';
  return table(
    fns.map((f) => [f.name, f.routing.defaultTarget, f.deployments.local ? `v${f.deployments.local.version}` : '-', f.deployments['aws-lambda'] ? `v${f.deployments['aws-lambda'].version}` : '-', iso(f.updatedAt)]),
    ['NAME', 'DEFAULT', 'LOCAL', 'AWS-LAMBDA', 'UPDATED'],
  );
}

export function renderDeployment(f: FunctionView): string {
  const lines = [`${f.name}  (id ${f.id})`, `  default target: ${f.routing.defaultTarget} (strategy: ${f.routing.strategy})`];
  for (const t of ['local', 'aws-lambda'] as const) {
    const d = f.deployments[t];
    if (!d) {
      lines.push(`  ${t}: not deployed`);
      continue;
    }
    lines.push(`  ${t}: v${d.version} ${d.status} (${d.id})`);
    for (const [k, v] of Object.entries(d.details)) {
      if (v === null || v === undefined) continue;
      lines.push(`      ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }
  }
  return lines.join('\n');
}

export function renderInvocations(recs: InvocationRecord[]): string {
  if (recs.length === 0) return 'No invocations yet.';
  return table(
    recs.map((r) => [iso(r.startedAt), r.target, r.status, r.source, r.coldStart === undefined ? '-' : r.coldStart ? 'cold' : 'warm', `${r.durationMs}ms`, r.errorCode ?? '', r.requestId]),
    ['TIME', 'TARGET', 'STATUS', 'SOURCE', 'START', 'DURATION', 'ERROR', 'REQUEST'],
  );
}

export function renderLogs(lines: LogLine[]): string {
  return lines.map((l) => `${iso(l.at)} ${l.stream === 'stderr' ? 'ERR' : l.stream === 'system' ? 'SYS' : 'OUT'} ${l.requestId ? `[${l.requestId.slice(0, 12)}] ` : ''}${l.message}`).join('\n');
}
