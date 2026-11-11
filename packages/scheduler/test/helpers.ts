import type { Metrics } from '@xero/core';

export class MetricsLike implements Metrics {
  readonly counters = new Map<string, number>();
  inc(name: string, _labels?: Record<string, string>, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  gauge(): void {}
  observe(): void {}
  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}
