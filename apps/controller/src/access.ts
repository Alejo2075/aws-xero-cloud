import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '@xero/shared';
import type { TokenScope } from '@xero/core';

export type RouteScope = 'read' | 'invoke' | 'admin';

/**
 * Required scope per route. Default is `admin`, so a new route is private until it is deliberately opened up.
 * read   : list/inspect functions, invocation history, metrics (no logs, no AWS calls)
 * invoke : POST /v1/invoke/*
 * admin  : everything else (deploy, bind, logs, AWS, backups, tokens, ...)
 */
export function requiredScope(method: string, path: string): RouteScope {
  if (method === 'POST' && path.startsWith('/v1/invoke/')) return 'invoke';
  if (method === 'GET' && !path.endsWith('/logs') && path !== '/v1/aws/connection' && path !== '/v1/doctor' && !path.startsWith('/v1/tokens')) return 'read';
  return 'admin';
}

export function scopeAllows(granted: TokenScope, needed: RouteScope): boolean {
  return granted === 'admin' || granted === needed;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newApiToken(scope: TokenScope): string {
  return `xero_${scope}_${randomBytes(24).toString('hex')}`;
}

/** Token bucket per principal. rps <= 0 disables limiting. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {}

  /** Returns 0 when allowed, otherwise the number of seconds to wait. */
  take(principal: string): number {
    if (this.rps <= 0) return 0;
    const now = this.clock.now();
    const b = this.buckets.get(principal) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rps);
    b.at = now;
    this.buckets.set(principal, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.rps));
  }
}
