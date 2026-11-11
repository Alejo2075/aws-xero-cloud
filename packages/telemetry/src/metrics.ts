import type { Metrics } from '@xero/core';

interface Series {
  name: string;
  labels: Record<string, string>;
}
interface CounterSeries extends Series {
  kind: 'counter';
  value: number;
}
interface GaugeSeries extends Series {
  kind: 'gauge';
  value: number;
}
interface SummarySeries extends Series {
  kind: 'summary';
  count: number;
  sum: number;
  max: number;
}
export type MetricSeries = CounterSeries | GaugeSeries | SummarySeries;

const keyOf = (name: string, labels: Record<string, string> = {}): string =>
  `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',')}}`;

/** In-memory metrics registry (counters, gauges, summaries). */
export class MetricsRegistry implements Metrics {
  private readonly series = new Map<string, MetricSeries>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const k = keyOf(name, labels);
    const s = this.series.get(k);
    if (s?.kind === 'counter') s.value += by;
    else this.series.set(k, { kind: 'counter', name, labels, value: by });
  }
  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.series.set(keyOf(name, labels), { kind: 'gauge', name, labels, value });
  }
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const k = keyOf(name, labels);
    const s = this.series.get(k);
    if (s?.kind === 'summary') {
      s.count += 1;
      s.sum += value;
      s.max = Math.max(s.max, value);
    } else this.series.set(k, { kind: 'summary', name, labels, count: 1, sum: value, max: value });
  }
  snapshot(): MetricSeries[] {
    return [...this.series.values()].map((s) => ({ ...s, labels: { ...s.labels } }));
  }
  /** Sum of a counter across label sets matching `match`. */
  counter(name: string, match: Record<string, string> = {}): number {
    let total = 0;
    for (const s of this.series.values()) {
      if (s.kind !== 'counter' || s.name !== name) continue;
      if (Object.entries(match).every(([k, v]) => s.labels[k] === v)) total += s.value;
    }
    return total;
  }
  renderPrometheus(): string {
    const esc = (v: string): string => v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
    const lbl = (l: Record<string, string>): string => {
      const e = Object.entries(l).sort(([a], [b]) => a.localeCompare(b));
      return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
    };
    const lines: string[] = [];
    for (const s of this.series.values()) {
      const n = `xero_${s.name}`;
      if (s.kind === 'summary') {
        lines.push(`${n}_count${lbl(s.labels)} ${s.count}`, `${n}_sum${lbl(s.labels)} ${s.sum}`, `${n}_max${lbl(s.labels)} ${s.max}`);
      } else lines.push(`${n}${lbl(s.labels)} ${s.value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
