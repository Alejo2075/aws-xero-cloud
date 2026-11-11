import { describe, expect, it } from 'vitest';
import { RuntimeCatalog } from '@xero/execution';
import { nodeRuntime } from '../src/index.js';

describe('node runtime adapter', () => {
  it('resolves images and handler files', () => {
    expect(nodeRuntime.imageFor('nodejs22.x')).toBe('public.ecr.aws/lambda/nodejs:22');
    expect(nodeRuntime.handlerFileCandidates('src/app.handler')).toEqual(['src/app.js', 'src/app.mjs', 'src/app.cjs']);
    expect(nodeRuntime.commandFor('index.handler')).toEqual(['index.handler']);
  });
  it('validates handlers', () => {
    expect(() => nodeRuntime.validateHandler('index.handler')).not.toThrow();
    expect(() => nodeRuntime.validateHandler('index')).toThrow();
    expect(() => nodeRuntime.validateHandler('../x.handler')).toThrow();
  });
  it('catalog rejects unknown runtimes', () => {
    const c = new RuntimeCatalog([nodeRuntime]);
    expect(c.adapterFor('nodejs20.x')).toBe(nodeRuntime);
    expect(() => c.adapterFor('python3.12')).toThrowError(expect.objectContaining({ code: 'RUNTIME_UNSUPPORTED' }));
  });
});
