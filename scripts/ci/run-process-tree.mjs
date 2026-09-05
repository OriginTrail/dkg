import { spawn, spawnSync } from 'node:child_process';

/** Bound a command and its descendants, including pnpm's shell/Node children. */
export function runProcessTree(command, args, { timeout, ...options } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
    let timer;
    let timeoutError;
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, error });
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, error: timeoutError });
    });
    if (timeout) {
      timer = setTimeout(() => {
        timeoutError = new Error(`Command timed out after ${timeout}ms`);
        // Kill the tree while its root is still alive. Killing pnpm first
        // would orphan its descendants and lose Windows taskkill's tree walk.
        if (process.platform === 'win32') {
          const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            encoding: 'utf8', timeout: 30_000, windowsHide: true,
          });
          if (killed.error || killed.status !== 0) {
            timeoutError = new Error(`${timeoutError.message}; process-tree cleanup failed: ${killed.error?.message ?? killed.stderr}`);
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') timeoutError = error;
          }
        }
        // close is delivered after the terminated command has been reaped.
      }, timeout);
    }
  });
}
