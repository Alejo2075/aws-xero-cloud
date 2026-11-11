#!/usr/bin/env node
import { XeroClient } from '@xero/sdk';
import { run } from './cli.js';

let cached: XeroClient | undefined;
const code = await run(process.argv.slice(2), {
  client: async () => (cached ??= await XeroClient.fromEnvironment()),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
  cwd: process.cwd(),
});
process.exitCode = code;
