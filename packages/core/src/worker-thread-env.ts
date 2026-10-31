// SPDX-License-Identifier: Apache-2.0

/**
 * Environment for a worker thread that opens no WebSockets.
 *
 * This package's entry point loads `ws`, and `ws` loads the optional native `bufferutil`. That
 * addon asserts that its setup calls succeed, and they fail once the thread is being terminated,
 * so terminating a thread during the load aborts the whole process. `ws` works without the addon.
 */
export function workerThreadEnv(): NodeJS.ProcessEnv {
  return { ...process.env, WS_NO_BUFFER_UTIL: '1' };
}
