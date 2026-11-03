// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { workerThreadEnv } from '../src/worker-thread-env.js';

afterEach(() => vi.unstubAllEnvs());

it('passes the environment on and keeps the native addon out, without changing this thread', () => {
  vi.stubEnv('DKG_WORKER_THREAD_ENV_TEST', 'kept');
  vi.stubEnv('WS_NO_BUFFER_UTIL', '');
  const env = workerThreadEnv();
  expect(env.DKG_WORKER_THREAD_ENV_TEST).toBe('kept');
  expect(env.WS_NO_BUFFER_UTIL).toBe('1');
  expect(process.env.WS_NO_BUFFER_UTIL).toBe('');
});
