import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

// The one launch policy for regression subprocesses: how a command is invoked
// on each platform, how long its output may stay open once its owner is gone,
// and which processes the runner may stop (only the ones it spawned). Proof
// execution, the launcher checks and registry discovery all go through here.

export const pnpmCommand = (platform = process.platform) => (platform === 'win32' ? 'pnpm.cmd' : 'pnpm');

// A pnpm lifecycle supplies its actual CLI entry. Launch that with Node (or
// directly for standalone pnpm.exe) so no cmd.exe parsing can alter arguments.
export function commandInvocation(command, args, { platform = process.platform, env = process.env, node = process.execPath } = {}) {
  if (platform !== 'win32' || path.win32.basename(command).toLowerCase() !== 'pnpm.cmd') return { command, args };
  const entry = env.npm_execpath;
  if (!entry || !path.win32.isAbsolute(entry) || !/^pnpm\.(?:c?js|exe)$/i.test(path.win32.basename(entry))) {
    throw new Error('Windows proof commands must run through pnpm (pnpm qa:prove-regression or pnpm test:regression-proofs)');
  }
  return /\.exe$/i.test(entry) ? { command: entry, args } : { command: node, args: [entry, ...args] };
}

export const pnpmInvocation = (args, options = {}) => commandInvocation(pnpmCommand(options.platform), args, options);

// How long a command's output may stay open after its launcher exited, or
// after its tree was stopped, before the runner stops waiting for it.
export const OUTPUT_SETTLE_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// Own only the spawned process group. Never kill a service discovered by port.
//
// The result says what happened to the command: `timedOut` at its deadline,
// `cancelled` when the signal aborted at any point before the result, and
// `error` for a launch failure, output over the limit, or output still open
// `settleMs` after the launcher exited or was stopped. That last case is a
// descendant outside the owned tree (taskkill follows only a live launcher), so
// the runner stops waiting for it rather than hang, and the phase fails
// whatever the launcher's own exit code was.
export function runCommand(command, args, cwd, log, timeoutMs, signal, { settleMs = OUTPUT_SETTLE_MS } = {}) {
  const invocation = commandInvocation(command, args);
  return new Promise((resolve) => {
    const output = fs.openSync(log, 'wx');
    let stdout = '', stderr = '', timedOut = false, cancelled = false, error, bytes = 0, finished = false, launcherExit, settleTimer;
    const child = spawn(invocation.command, invocation.args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code, terminationSignal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(settleTimer); signal?.removeEventListener('abort', cancel); fs.closeSync(output);
      resolve({ command, args, invocation, code, signal: terminationSignal, timedOut, ...(cancelled ? { cancelled } : {}),
        ...(error ? { error } : {}), stdout, stderr });
    };
    const abandonOutput = (reason) => {
      settleTimer ??= setTimeout(() => {
        error ??= `${reason}; the output was still open ${settleMs} ms later`;
        child.stdout?.destroy(); child.stderr?.destroy();
        finish(launcherExit?.code ?? null, launcherExit?.signal ?? null);
      }, settleMs);
    };
    const collect = (kind, data) => {
      if (finished) return;
      bytes += data.length;
      if (bytes > MAX_OUTPUT_BYTES) { error ??= 'phase output exceeds 8 MiB'; stop(); return; }
      fs.writeSync(output, data);
      if (kind === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* process already exited */ }
      abandonOutput('the owned process tree did not release its output after being stopped');
    };
    const cancel = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout?.on('data', (data) => collect('stdout', data));
    child.stderr?.on('data', (data) => collect('stderr', data));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', (failure) => { error ??= failure.message; });
    child.on('exit', (code, terminationSignal) => {
      launcherExit = { code, signal: terminationSignal };
      abandonOutput('a descendant kept the output open after the launcher exited');
    });
    child.on('close', finish);
  });
}
