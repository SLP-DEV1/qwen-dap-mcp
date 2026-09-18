import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { DapError } from '../dap/errors.js';
import { buildRrReplayPlan, type RrDiscoveryResult } from './rr.js';

export type ManagedRrReplayStatus = {
  running: boolean;
  pid?: number;
  traceDir?: string;
  port?: number;
  rr?: RrDiscoveryResult;
  stderrTail: string[];
  startedAt?: string;
};

const MAX_STDERR_LINES = 100;

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export class ManagedRrReplay {
  private child?: ChildProcessWithoutNullStreams;
  private stderrLines: string[] = [];
  private traceDir?: string;
  private port?: number;
  private rr?: RrDiscoveryResult;
  private startedAt?: string;

  status(): ManagedRrReplayStatus {
    const child = this.child;
    return {
      running: Boolean(child && !hasExited(child)),
      ...(child?.pid ? { pid: child.pid } : {}),
      ...(this.traceDir ? { traceDir: this.traceDir } : {}),
      ...(this.port ? { port: this.port } : {}),
      ...(this.rr ? { rr: this.rr } : {}),
      stderrTail: [...this.stderrLines],
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
    };
  }

  async start(options: {
    traceDir: string;
    port: number;
    rrPath?: string;
    readyTimeoutMs?: number;
  }): Promise<ManagedRrReplayStatus> {
    if (this.child && !hasExited(this.child)) {
      throw new DapError('An rr replay process is already running for this debugger session.');
    }

    const plan = buildRrReplayPlan({
      traceDir: options.traceDir,
      port: options.port,
      ...(options.rrPath ? { rrPath: options.rrPath } : {}),
    });
    this.stderrLines = [];
    this.traceDir = plan.traceDir;
    this.port = options.port;
    this.rr = plan.rr;
    this.startedAt = new Date().toISOString();

    const child = spawn(plan.command, plan.args, {
      cwd: plan.traceDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    const capture = (chunk: Buffer | string) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      this.stderrLines.push(...lines);
      if (this.stderrLines.length > MAX_STDERR_LINES) {
        this.stderrLines.splice(0, this.stderrLines.length - MAX_STDERR_LINES);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new DapError(`Failed to start rr replay: ${error.message}`, { cause: error }));
      };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    const readyTimeoutMs = Math.min(Math.max(options.readyTimeoutMs ?? 3_000, 250), 15_000);
    const started = Date.now();
    while (Date.now() - started < readyTimeoutMs) {
      if (hasExited(child)) {
        const detail = child.signalCode ? `signal ${child.signalCode}` : `exit code ${String(child.exitCode)}`;
        throw new DapError(`rr replay exited before debugger attach (${detail}). stderr: ${this.stderrLines.slice(-10).join(' | ')}`);
      }
      if (this.stderrLines.some((line) => /listen|gdb|remote|waiting/i.test(line))) break;
      if (Date.now() - started >= 750) break;
      await delay(100);
    }

    return this.status();
  }

  async stop(): Promise<ManagedRrReplayStatus> {
    const child = this.child;
    if (!child) return this.status();
    if (!hasExited(child)) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 1_500;
      while (!hasExited(child) && Date.now() < deadline) await delay(50);
      if (!hasExited(child)) {
        child.kill('SIGKILL');
        await delay(50);
      }
    }
    this.child = undefined;
    return this.status();
  }
}
