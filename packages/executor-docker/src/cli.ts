import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}
export interface RunOptions {
  /** Extra environment for the child process (used to pass secrets without exposing them in argv). */
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}
export type CommandRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<CommandResult>;

export interface SpawnedProcess {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  onExit(cb: () => void): void;
}
export type ProcessSpawner = (command: string, args: readonly string[]) => SpawnedProcess;

/** Default runner: never throws on non-zero exit; throws only when the binary cannot be started. */
export const execRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env: { ...process.env, ...options.env }, timeout: options.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, signal: options.signal },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(error);
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });

export const defaultSpawner: ProcessSpawner = (command, args) => {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill('SIGTERM'),
    onExit: (cb) => child.once('exit', cb),
  };
};
