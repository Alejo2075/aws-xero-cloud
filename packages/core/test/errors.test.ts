import { describe, expect, it } from 'vitest';
import { XeroError, toXeroError } from '../src/index.js';

describe('XeroError', () => {
  it('maps codes to http status and serialises without cause', () => {
    const e = new XeroError('CAPACITY_EXHAUSTED', 'busy', { queue: 3 });
    expect(e.httpStatus).toBe(429);
    expect(e.toJSON()).toEqual({ code: 'CAPACITY_EXHAUSTED', message: 'busy', details: { queue: 3 } });
  });
  it('wraps unknown errors as INTERNAL without leaking the message', () => {
    const e = toXeroError(new Error('secret=abc'));
    expect(e.code).toBe('INTERNAL');
    expect(e.message).not.toContain('secret');
  });
});
