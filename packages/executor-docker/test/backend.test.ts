import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerSpec } from '@xero/execution';
import { DockerBackend, buildRunArgs, serializeEnvFile, type CommandRunner } from '../src/index.js';

const spec: WorkerSpec = {
  workerId: 'w1', functionId: 'fn_1', deploymentId: 'dep_1', functionName: 'hello',
  image: 'public.ecr.aws/lambda/nodejs:22', command: ['index.handler'], artifactPath: '/store/abc',
  memoryMb: 256, timeoutSec: 5, environment: { AWS_SESSION_TOKEN: 'TOPSECRETTOKENVALUE', TABLE_NAME: 'orders' },
};

describe('buildRunArgs', () => {
  const args = buildRunArgs(spec, { pidsLimit: 256, tmpfsSizeMb: 512, user: '1000:1000', envFile: '/tmp/xero-env-x/env' });
  const joined = args.join(' ');
  it('applies container hardening', () => {
    for (const f of ['--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 256', '--memory 256m', '--memory-swap 256m', '--user 1000:1000', '--publish 127.0.0.1::8080', '--volume /store/abc:/var/task:ro'])
      expect(joined).toContain(f);
    expect(joined).not.toContain('--privileged');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toMatch(/--network\s+host/);
  });
  it('mounts only the artifact and never the home dir', () => {
    expect(args.filter((a) => a === '--volume')).toHaveLength(1);
  });
  it('keeps secret values out of argv', () => {
    expect(joined).not.toContain('TOPSECRETTOKENVALUE');
    expect(args).toContain('--env-file');
    expect(args).not.toContain('AWS_SESSION_TOKEN');
    expect(args.at(-2)).toBe(spec.image);
    expect(args.at(-1)).toBe('index.handler');
  });
});

interface Call { args: readonly string[]; env: Record<string, string> | undefined; envFile?: string | undefined; envFileBody?: string | undefined }
function fakeDocker(port: number, state: { Running: boolean; OOMKilled?: boolean; ExitCode?: number } = { Running: true }) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (_c, args, o) => {
    const i = args.indexOf('--env-file');
    const envFile = i >= 0 ? args[i + 1] : undefined;
    calls.push({ args, env: o?.env, envFile, envFileBody: envFile && existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined });
    switch (args[0]) {
      case 'run': return { stdout: 'cid123\n', stderr: '', code: 0 };
      case 'port': return { stdout: `127.0.0.1:${port}\n`, stderr: '', code: 0 };
      case 'inspect': return { stdout: JSON.stringify(state), stderr: '', code: 0 };
      case 'rm': return { stdout: '', stderr: '', code: 0 };
      case 'version': return { stdout: '29.1.5', stderr: '', code: 0 };
      case 'ps': return { stdout: 'abc\tw9\trunning\ndef\tw8\texited\n', stderr: '', code: 0 };
      default: return { stdout: '', stderr: '', code: 0 };
    }
  };
  return { runner, calls };
}

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

describe('DockerBackend', () => {
  it('starts a worker, passes variables via a private env-file (not argv, not the docker client env)', async () => {
    const port = await listen((_q, s) => s.end('{}'));
    const { runner, calls } = fakeDocker(port);
    const hostile = { ...spec, environment: { ...spec.environment, DOCKER_HOST: 'tcp://evil:2375', LD_PRELOAD: '/x.so', DYLD_INSERT_LIBRARIES: '/y' } };
    const b = new DockerBackend({ runner });
    const h = await b.startWorker(hostile);
    expect(h.endpoint).toBe(`http://127.0.0.1:${port}`);
    const run = calls.find((c) => c.args[0] === 'run')!;
    expect(run.env).toBeUndefined(); // docker CLI environment is untouched by function configuration
    expect(run.args.join(' ')).not.toContain('TOPSECRETTOKENVALUE');
    expect(run.args.join(' ')).not.toContain('evil');
    expect(run.envFileBody).toContain('AWS_SESSION_TOKEN=TOPSECRETTOKENVALUE');
    expect(run.envFileBody).toContain('DOCKER_HOST=tcp://evil:2375'); // reaches the container only
    expect(existsSync(run.envFile!)).toBe(false); // removed right after docker run
  });

  it('rejects environment values that cannot be represented safely', () => {
    expect(() => serializeEnvFile({ A: 'x\nB=y' })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => serializeEnvFile({ 'A B': 'x' })).toThrow();
    expect(serializeEnvFile({ A: 'x', B: 'y=z' })).toBe('A=x\nB=y=z\n');
  });

  it('invokes via the runtime interface endpoint and classifies handler errors', async () => {
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        expect(req.url).toBe('/2015-03-31/functions/function/invocations');
        const body = Buffer.concat(chunks).toString();
        if (body.includes('boom')) res.end(JSON.stringify({ errorType: 'Error', errorMessage: 'boom' }));
        else res.end(JSON.stringify({ echo: JSON.parse(body) }));
      });
    });
    const { runner } = fakeDocker(port);
    const b = new DockerBackend({ runner });
    const h = await b.startWorker(spec);
    const ok = await b.invoke(h, { requestId: 'r', payload: Buffer.from('{"a":1}'), deadlineAt: Date.now() + 5000 });
    expect(ok.outcome).toBe('ok');
    expect(JSON.parse(Buffer.from(ok.payload).toString())).toEqual({ echo: { a: 1 } });
    const bad = await b.invoke(h, { requestId: 'r2', payload: Buffer.from('"boom"'), deadlineAt: Date.now() + 5000 });
    expect(bad.outcome).toBe('function-error');
  });

  it('fences the worker (docker rm -f) on timeout', async () => {
    const port = await listen(() => undefined); // never responds
    const { runner, calls } = fakeDocker(port);
    const b = new DockerBackend({ runner });
    const h = await b.startWorker(spec);
    await expect(b.invoke(h, { requestId: 'r', payload: Buffer.from('{}'), deadlineAt: Date.now() + 150 })).rejects.toMatchObject({ code: 'INVOCATION_TIMEOUT' });
    expect(calls.some((c) => c.args[0] === 'rm' && c.args.includes('cid123'))).toBe(true);
  });

  it('reports OOM and crash distinctly', async () => {
    const port = await listen((req) => req.socket.destroy());
    const oom = fakeDocker(port, { Running: false, OOMKilled: true, ExitCode: 137 });
    const b1 = new DockerBackend({ runner: oom.runner });
    const h = await b1.startWorker(spec).catch(() => undefined);
    // startup probe sees the destroyed socket as not-ready then a stopped container, so build the handle by hand.
    const handle = h ?? { workerId: 'w1', backendId: 'cid123', endpoint: `http://127.0.0.1:${port}`, startedAt: 0 };
    await expect(b1.invoke(handle, { requestId: 'r', payload: Buffer.from('{}'), deadlineAt: Date.now() + 3000 })).rejects.toMatchObject({ code: 'WORKER_OOM' });
    const crash = fakeDocker(port, { Running: false, ExitCode: 1 });
    const b2 = new DockerBackend({ runner: crash.runner });
    await expect(b2.invoke(handle, { requestId: 'r', payload: Buffer.from('{}'), deadlineAt: Date.now() + 3000 })).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
  });

  it('maps a missing/stopped engine to BACKEND_UNAVAILABLE', async () => {
    const down = new DockerBackend({ runner: async () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 }) });
    await expect(down.ping()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    const missing = new DockerBackend({ runner: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    await expect(missing.ping()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  });

  it('recognises both old and new docker CLI "daemon not running" messages as BACKEND_UNAVAILABLE', async () => {
    for (const stderr of [
      'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory',
      'docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    ]) {
      const b = new DockerBackend({ runner: async () => ({ stdout: '', stderr, code: 125 }) });
      await expect(b.startWorker(spec)).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    }
  });

  it('start failure surfaces WORKER_START_FAILED', async () => {
    const b = new DockerBackend({ runner: async () => ({ stdout: '', stderr: 'pull access denied', code: 125 }) });
    await expect(b.startWorker(spec)).rejects.toMatchObject({ code: 'WORKER_START_FAILED' });
  });

  it('lists managed workers for orphan reaping', async () => {
    const b = new DockerBackend({ runner: fakeDocker(1).runner });
    expect(await b.listManaged()).toEqual([
      { backendId: 'abc', workerId: 'w9', running: true },
      { backendId: 'def', workerId: 'w8', running: false },
    ]);
  });
});
