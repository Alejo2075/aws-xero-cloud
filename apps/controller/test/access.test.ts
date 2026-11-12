import { describe, expect, it } from 'vitest';
import { RateLimiter, hashToken, newApiToken, requiredScope, scopeAllows } from '../src/access.js';

describe('route scopes', () => {
  it.each([
    ['POST', '/v1/invoke/hello', 'invoke'],
    ['GET', '/v1/functions', 'read'],
    ['GET', '/v1/functions/hello', 'read'],
    ['GET', '/v1/functions/hello/invocations', 'read'],
    ['GET', '/v1/metrics', 'read'],
    ['GET', '/v1/functions/hello/logs', 'admin'],
    ['GET', '/v1/aws/connection', 'admin'],
    ['GET', '/v1/doctor', 'admin'],
    ['GET', '/v1/tokens', 'admin'],
    ['POST', '/v1/functions/hello/deployments/local', 'admin'],
    ['DELETE', '/v1/functions/hello', 'admin'],
    ['POST', '/v1/backups', 'admin'],
    ['GET', '/v1/something-new', 'read'],
    ['PUT', '/v1/something-new', 'admin'],
  ])('%s %s needs %s', (m, p, s) => expect(requiredScope(m, p)).toBe(s));

  it('scope hierarchy: admin does everything; read and invoke do only their own', () => {
    expect(scopeAllows('admin', 'invoke')).toBe(true);
    expect(scopeAllows('read', 'invoke')).toBe(false);
    expect(scopeAllows('invoke', 'read')).toBe(false);
    expect(scopeAllows('invoke', 'invoke')).toBe(true);
    expect(scopeAllows('read', 'admin')).toBe(false);
  });
});

describe('tokens', () => {
  it('generates unguessable, scope-tagged tokens and hashes them', () => {
    const a = newApiToken('read');
    expect(a).toMatch(/^xero_read_[0-9a-f]{48}$/);
    expect(newApiToken('read')).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then refills at the configured rate, per principal', () => {
    let now = 0;
    const l = new RateLimiter(2, 4, { now: () => now });
    for (let i = 0; i < 4; i++) expect(l.take('a')).toBe(0);
    expect(l.take('a')).toBeGreaterThan(0);
    expect(l.take('b')).toBe(0); // other principals are independent
    now += 1000; // 2 tokens refilled
    expect(l.take('a')).toBe(0);
    expect(l.take('a')).toBe(0);
    expect(l.take('a')).toBeGreaterThan(0);
  });
  it('rps 0 disables limiting', () => {
    const l = new RateLimiter(0, 0, { now: () => 0 });
    for (let i = 0; i < 1000; i++) expect(l.take('x')).toBe(0);
  });
});
