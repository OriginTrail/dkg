// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef } from 'react';
import {
  CoalescingRecurringTask,
  type CoalescingRecurringTaskOptions,
} from '@origintrail-official/dkg-core/coalescing-recurring-task';

/** Retire each effect's task before a new scope or StrictMode owner reads. */
export function useCoalescingRecurringTask(
  scopeKey: string,
  runPass: CoalescingRecurringTaskOptions['runPass'],
) {
  const task = useRef<CoalescingRecurringTask | null>(null);
  const retirement = useRef<Promise<void>>(Promise.resolve());

  const refresh = useCallback(async () => {
    const current = task.current;
    if (current?.request()) await current.whenIdle();
  }, []);

  useEffect(() => {
    const predecessor = retirement.current;
    const current = new CoalescingRecurringTask({
      runPass: async signal => {
        // close() fences results immediately, but an HTTP transport may ignore
        // cancellation. Drain it physically before admitting a successor read.
        await predecessor;
        if (signal.aborted) return 'idle';
        return runPass(signal);
      },
      onError: error => console.error('Memory layer refresh failed', error),
      closingMessage: 'Memory layer snapshot scope retired',
    });
    task.current = current;
    current.request();
    return () => {
      if (task.current === current) task.current = null;
      retirement.current = current.close();
    };
  }, [scopeKey, runPass]);

  return refresh;
}
