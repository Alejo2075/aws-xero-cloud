import { randomUUID } from 'node:crypto';

/** Injectable monotonic-ish wall clock (milliseconds since epoch). */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** Injectable id source so tests can be deterministic. */
export type IdGenerator = (prefix: string) => string;
export const newId: IdGenerator = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

/** Abortable sleep. Resolves early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Deferred promise helper. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;
