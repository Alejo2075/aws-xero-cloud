import { XeroError } from '@xero/core';
import { imageOverride, type RuntimeAdapter } from '@xero/execution';
import type { Runtime } from '@xero/specification';

const IMAGES: Record<string, string> = {
  'nodejs20.x': 'public.ecr.aws/lambda/nodejs:20',
  'nodejs22.x': 'public.ecr.aws/lambda/nodejs:22',
};
const HANDLER = /^([A-Za-z0-9_./-]+)\.([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)$/;

/** Node.js handlers run through the official AWS Lambda Node.js runtime interface (RIE) inside the image. */
export const nodeRuntime: RuntimeAdapter = {
  family: 'nodejs',
  runtimes: ['nodejs20.x', 'nodejs22.x'],
  imageFor: (runtime: Runtime) => imageOverride(runtime) ?? IMAGES[runtime]!,
  validateHandler(handler) {
    if (!HANDLER.test(handler) || handler.includes('..')) {
      throw new XeroError('INVALID_REQUEST', `invalid Node.js handler "${handler}" (expected "file.export")`);
    }
  },
  handlerFileCandidates(handler) {
    const m = HANDLER.exec(handler);
    const base = m![1]!;
    return ['.js', '.mjs', '.cjs'].map((ext) => `${base}${ext}`);
  },
  commandFor: (handler) => [handler],
};
