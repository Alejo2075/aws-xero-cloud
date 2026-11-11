import type { FunctionView, InvocationRecord, LogLine } from '@xero/sdk';

/** Escapes C0/C1 control characters (incl. ESC) in untrusted text so it cannot drive the terminal. */
export function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows.map((r) => r.map(clean))];
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
  const lines = [`${clean(f.name)}  (id ${f.id})`, `  default target: ${f.routing.defaultTarget} (strategy: ${f.routing.strategy})`];
  for (const t of ['local', 'aws-lambda'] as const) {
    const d = f.deployments[t];
    if (!d) {
      lines.push(`  ${t}: not deployed`);
      continue;
    }
    lines.push(`  ${t}: v${d.version} ${d.status} (${d.id})`);
    for (const [k, v] of Object.entries(d.details)) {
      if (v === null || v === undefined) continue;
      lines.push(`      ${k}: ${clean(typeof v === 'object' ? JSON.stringify(v) : String(v))}`);
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
  return lines.map((l) => `${iso(l.at)} ${l.stream === 'stderr' ? 'ERR' : l.stream === 'system' ? 'SYS' : 'OUT'} ${l.requestId ? `[${l.requestId.slice(0, 12)}] ` : ''}${clean(l.message)}`).join('\n');
}
