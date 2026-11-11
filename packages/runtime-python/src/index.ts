import { XeroError } from '@xero/core';
import { imageOverride, type RuntimeAdapter } from '@xero/execution';
import type { Runtime } from '@xero/specification';

const IMAGES: Record<string, string> = {
  'python3.12': 'public.ecr.aws/lambda/python:3.12',
  'python3.13': 'public.ecr.aws/lambda/python:3.13',
};
const HANDLER = /^([A-Za-z0-9_./-]+)\.([A-Za-z_][A-Za-z0-9_]*)$/;

/** Python handlers run through the official AWS Lambda Python runtime interface (RIE) inside the image. */
export const pythonRuntime: RuntimeAdapter = {
  family: 'python',
  runtimes: ['python3.12', 'python3.13'],
  imageFor: (runtime: Runtime) => imageOverride(runtime) ?? IMAGES[runtime]!,
  validateHandler(handler) {
    if (!HANDLER.test(handler) || handler.includes('..')) {
      throw new XeroError('INVALID_REQUEST', `invalid Python handler "${handler}" (expected "module.function")`);
    }
  },
  handlerFileCandidates(handler) {
    const m = HANDLER.exec(handler);
    return [`${m![1]!}.py`];
  },
  commandFor: (handler) => [handler],
};
