import type { ServerResponse } from 'node:http';

/** Stop pre-persistence admission when its response is gone; never cancel a durable share job. */
export async function admitShareWhileConnected<T>(
  response: ServerResponse,
  admit: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (response.destroyed || response.writableEnded) return undefined;
  const controller = new AbortController();
  const onClose = () => controller.abort();
  response.once('close', onClose);
  try {
    if (response.destroyed || response.writableEnded) return undefined;
    return await admit(controller.signal);
  } finally {
    response.off('close', onClose);
  }
}
