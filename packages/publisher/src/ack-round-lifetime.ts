import { setTimeout as delay } from 'node:timers/promises';
import { resolveWithinAbort } from '@origintrail-official/dkg-core';

/** Own caller-side work only; remote handlers retain their own physical lifetime. */
export function createACKRoundLifetime(
  timeoutMs: number, timeoutError: () => Error, caller?: AbortSignal,
) {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const followCaller = () => controller.abort(caller!.reason);
  caller?.addEventListener('abort', followCaller, { once: true });
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  // A digest/candidate failure can dispose before the collector installs its race.
  void aborted.catch(() => {});
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  return {
    signal: controller.signal,
    aborted,
    sleep: async (ms: number, customSleep?: (ms: number) => Promise<void>) => {
      if (customSleep) await resolveWithinAbort(() => customSleep(ms), controller.signal);
      else await delay(ms, undefined, { signal: controller.signal });
    },
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', followCaller);
      controller.abort(new Error('StorageACK round settled'));
      controller.signal.removeEventListener('abort', onAbort);
    },
  };
}
