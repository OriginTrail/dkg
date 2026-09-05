import { setTimeout as delay } from 'node:timers/promises';

const owners = new WeakMap();

/** Attach immediately after spawn. Services supply readiness; this utility owns lifetime. */
export function ownProcess(child, { label = 'Owned child', graceMs = 1200, killTimeoutMs = 2000 } = {}) {
  if (owners.has(child)) return owners.get(child);
  let stdout = '';
  let stderr = '';
  let spawnError;
  let result;
  let stopping;
  const capture = (previous, chunk) => (previous + chunk.toString()).slice(-2 * 1024 * 1024);
  child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });
  child.once('error', (error) => { spawnError = error; });
  // close, not exit, proves stdio has drained and retains late failure diagnostics.
  const closed = new Promise((resolve) => child.once('close', (code, signal) => {
    result = { code, signal, error: spawnError };
    resolve(result);
  }));
  const failure = () => new Error(`${label} closed (code ${result?.code}, signal ${result?.signal})${spawnError ? `: ${spawnError.message}` : ''}`);
  const diagnosticError = (error) => new Error(`${error.message}\nstderr: ${stderr}\nstdout: ${stdout}`, { cause: error });
  async function deadline(promise, timeoutMs) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  const owner = {
    child, closed,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    stop() {
      stopping ??= (async () => {
        if (result) return;
        child.kill('SIGTERM');
        try { await deadline(closed, graceMs); }
        catch {
          child.kill('SIGKILL');
          // Never delete a service's files or claim teardown before close.
          await deadline(closed, killTimeoutMs);
        }
      })();
      return stopping;
    },
    async ready(probe, { timeoutMs = 45_000, intervalMs = 100 } = {}) {
      const controller = new AbortController();
      try {
        const value = await deadline(Promise.race([
          closed.then(() => { throw failure(); }),
          (async () => {
            while (true) {
              controller.signal.throwIfAborted();
              const value = await probe({ signal: controller.signal, stdout: () => stdout });
              if (value !== undefined) return value;
              await delay(intervalMs, undefined, { signal: controller.signal });
            }
          })(),
        ]), timeoutMs);
        if (result || spawnError || child.exitCode != null || child.signalCode != null) throw failure();
        return value;
      } catch (error) {
        controller.abort();
        await owner.stop();
        throw diagnosticError(error);
      } finally { controller.abort(); }
    },
    async waitForExit(timeoutMs = 300_000) {
      try {
        const exit = await deadline(closed, timeoutMs);
        if (exit.error || exit.code !== 0 || exit.signal) throw failure();
        return { stdout, stderr };
      } catch (error) {
        await owner.stop();
        throw diagnosticError(error);
      }
    },
  };
  owners.set(child, owner);
  return owner;
}
