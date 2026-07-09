import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  resolveBooleanSwitch,
  resolveNonNegativeIntegerSwitch,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('sync global backpressure', () => {
  it('serializes concurrent sync work when global limit is 1 while non-sync work can proceed', async () => {
    const ctx = createOperationContext('sync');
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = withGlobalSyncBackpressure(
      { limit: 1, ctx, label: 'first' },
      async () => {
        events.push('first-start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push('first-end');
      },
    );
    await tick();

    const second = withGlobalSyncBackpressure(
      { limit: 1, ctx, label: 'second' },
      async () => {
        events.push('second-start');
      },
    );
    await tick();

    events.push('storage-ack-work');
    expect(events).toEqual(['first-start', 'storage-ack-work']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'storage-ack-work', 'first-end', 'second-start']);
  });

  it('env switches override config values for emergency controls', () => {
    const oldReconciler = process.env.DKG_SYNC_RECONCILER_ENABLED;
    const oldDeadline = process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS;
    try {
      process.env.DKG_SYNC_RECONCILER_ENABLED = '0';
      process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS = '60000';

      expect(resolveBooleanSwitch(true, 'DKG_SYNC_RECONCILER_ENABLED', true)).toBe(false);
      expect(resolveNonNegativeIntegerSwitch(15_000, 'DKG_STORAGE_ACK_HANDLER_DEADLINE_MS')).toBe(60_000);
    } finally {
      if (oldReconciler === undefined) delete process.env.DKG_SYNC_RECONCILER_ENABLED;
      else process.env.DKG_SYNC_RECONCILER_ENABLED = oldReconciler;
      if (oldDeadline === undefined) delete process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS;
      else process.env.DKG_STORAGE_ACK_HANDLER_DEADLINE_MS = oldDeadline;
    }
  });
});
