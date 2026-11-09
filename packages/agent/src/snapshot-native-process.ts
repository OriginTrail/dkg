// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';

/** Own only the child we created. Cancellation waits for physical process exit. */
export async function startSnapshotNativeProcess(command: string, args: string[], cwd: string, log: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const output = await open(log, 'wx', 0o600);
  let child: ChildProcess;
  try { child = spawn(command, args, { cwd, stdio: ['ignore', output.fd, output.fd], shell: false }); }
  catch (error) { await output.close(); throw error; }
  let finished = false;
  let processError: Error | undefined;
  const closed = new Promise<number>((resolve, reject) => {
    // Even a failed spawn emits close. Never release ownership on error alone:
    // physical exit and stdio closure are the completion boundary.
    child.once('error', error => { processError = error; });
    child.once('close', (code, killed) => {
      finished = true;
      if (processError) reject(processError);
      else if (code === 0) resolve(0);
      else reject(new Error(`Snapshot process failed (${code ?? killed})`));
    });
  });
  // Long-lived audit servers may close before a caller awaits closed.
  void closed.catch(() => undefined);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (!finished) child.kill('SIGTERM');
    const kill = setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 20_000);
    try { await closed.catch(() => undefined); }
    finally { clearTimeout(kill); signal.removeEventListener('abort', aborted); await output.close(); }
  })();
  const aborted = () => { void stop().catch(() => undefined); };
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  return { closed, stop, assertRunning: () => {
    signal.throwIfAborted(); if (finished) throw new Error('Snapshot process exited before audit');
  } };
}
