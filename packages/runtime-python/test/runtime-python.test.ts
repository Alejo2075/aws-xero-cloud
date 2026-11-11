import { describe, expect, it } from 'vitest';
import { pythonRuntime } from '../src/index.js';

describe('python runtime adapter', () => {
  it('resolves images and handler files', () => {
    expect(pythonRuntime.imageFor('python3.13')).toBe('public.ecr.aws/lambda/python:3.13');
    expect(pythonRuntime.handlerFileCandidates('app.handler')).toEqual(['app.py']);
  });
  it('validates handlers', () => {
    expect(() => pythonRuntime.validateHandler('app.handler')).not.toThrow();
    expect(() => pythonRuntime.validateHandler('app')).toThrow();
    expect(() => pythonRuntime.validateHandler('app.1bad')).toThrow();
  });
  it('honours image overrides from env', () => {
    process.env.XERO_IMAGE_PYTHON3_12 = 'registry.local/py:pinned';
    try {
      expect(pythonRuntime.imageFor('python3.12')).toBe('registry.local/py:pinned');
    } finally {
      delete process.env.XERO_IMAGE_PYTHON3_12;
    }
  });
});
