/**
 * Starts the real API server as a child process and proves the harness owns it.
 *
 * Ownership checks (slice 3 plan §0.1, D-017a):
 * 1. The server is started with PORT=0, so the OS assigns a free port. No fixed port can collide.
 * 2. The port is taken only from the ready line printed on *this child's* stdout pipe, never from a guess.
 * 3. The PID in that line must equal the spawned child's PID.
 * 4. The child must still be alive, and GET /health on that port must return 200 before the deadline.
 *
 * Failure behavior is explicit: early exit, ready-line timeout or a failed health check reject with a clear
 * message (including the child's recent stderr), after the child has been stopped. There are no fixed sleeps:
 * the code waits on events, and the health probe retries only until a deadline.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export const READY_LINE = /^MonetaLab API listening on http:\/\/127\.0\.0\.1:(\d+) \(pid (\d+)\)$/m;

export type OwnedServer = {
  pid: number;
  port: number;
  baseUrl: string;
  /** Recent stdout/stderr lines, for diagnostics. Never contains request bodies. */
  output: () => string;
  stop: () => Promise<StopResult>;
};

export type StopResult = { exitCode: number | null; signal: NodeJS.Signals | null; forced: boolean };

export type StartOptions = {
  command?: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
};

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function stopChild(child: ChildProcess, stopTimeoutMs = 5_000): Promise<StopResult> {
  let forced = false;
  if (!hasExited(child)) {
    child.kill('SIGTERM');
    if (!(await waitForExit(child, stopTimeoutMs))) {
      forced = true;
      child.kill('SIGKILL');
      await waitForExit(child, 2_000);
    }
  }
  return { exitCode: child.exitCode, signal: child.signalCode, forced };
}

async function probeHealth(baseUrl: string, child: ChildProcess, deadline: number): Promise<void> {
  let lastProblem = 'no attempt made';
  while (Date.now() < deadline) {
    if (hasExited(child)) throw new Error('server process exited during the health check');
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
      lastProblem = `GET /health returned ${response.status}`;
    } catch (error) {
      lastProblem = `GET /health failed: ${(error as Error).message}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100)); // short backoff between retries, bounded by the deadline
  }
  throw new Error(`health check did not succeed before the deadline (${lastProblem})`);
}

export async function startOwnedServer(options: StartOptions): Promise<OwnedServer> {
  const {
    command = process.execPath,
    args = ['src/server.ts'],
    cwd,
    env,
    readyTimeoutMs = 15_000,
    healthTimeoutMs = 10_000,
    stopTimeoutMs = 5_000,
  } = options;

  const child = spawn(command, args, { cwd, env: { ...env, PORT: '0', API_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const recent: string[] = [];
  const remember = (source: string) => (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) recent.push(`[${source}] ${line}`);
    while (recent.length > 50) recent.shift();
  };
  child.stderr!.on('data', remember('stderr'));
  const output = () => recent.join('\n');

  // Last-resort cleanup if the test runner process exits without running teardown.
  const killOnExit = () => {
    if (!hasExited(child)) child.kill('SIGKILL');
  };
  process.once('exit', killOnExit);

  const fail = async (reason: string): Promise<never> => {
    await stopChild(child, stopTimeoutMs);
    process.off('exit', killOnExit);
    throw new Error(`API test server failed to start: ${reason}\n--- recent server output ---\n${output()}`);
  };

  let ready: { port: number; pid: number };
  try {
    ready = await new Promise((resolve, reject) => {
      let stdoutBuffer = '';
      const timer = setTimeout(
        () => reject(new Error(`no ready line within ${readyTimeoutMs} ms`)),
        readyTimeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout!.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const onData = (chunk: Buffer) => {
        remember('stdout')(chunk);
        stdoutBuffer += chunk.toString('utf8');
        const match = READY_LINE.exec(stdoutBuffer);
        if (match) {
          cleanup();
          child.stdout!.on('data', remember('stdout')); // keep draining stdout so the pipe never fills
          resolve({ port: Number(match[1]), pid: Number(match[2]) });
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`server exited before it was ready (exit code ${code}, signal ${signal})`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`could not spawn server: ${error.message}`));
      };
      child.stdout!.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  } catch (error) {
    return fail((error as Error).message);
  }

  if (ready.pid !== child.pid) return fail(`ready line reported pid ${ready.pid}, but the spawned child is pid ${child.pid}`);
  if (!(ready.port > 0 && ready.port <= 65_535)) return fail(`ready line reported an invalid port ${ready.port}`);
  if (hasExited(child)) return fail('server exited right after reporting ready');

  const baseUrl = `http://127.0.0.1:${ready.port}`;
  try {
    await probeHealth(baseUrl, child, Date.now() + healthTimeoutMs);
  } catch (error) {
    return fail((error as Error).message);
  }

  return {
    pid: child.pid!,
    port: ready.port,
    baseUrl,
    output,
    stop: async () => {
      const result = await stopChild(child, stopTimeoutMs);
      process.off('exit', killOnExit);
      return result;
    },
  };
}
