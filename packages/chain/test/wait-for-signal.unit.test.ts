// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { waitForSignal } from '../src/wait-for-signal.js';

describe('waitForSignal', () => {
  it('surfaces the waiter abort Error by identity', async () => {
    const controller = new AbortController();
    const reason = new Error('authority-index waiter left');
    const waiting = waitForSignal(new Promise<never>(() => undefined), controller.signal);

    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
  });

  it('normalizes a non-Error abort reason to the shared AbortError contract', async () => {
    const signal = AbortSignal.abort('cancelled');

    await expect(waitForSignal(Promise.resolve(1), signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Shared request waiter aborted',
    });
  });
});
