import { afterEach, vi } from 'vitest';
import { BULK_GRAPH_PROTOCOL, BulkGraphSession, type BulkGraphFrame, type ProtocolRouter } from '@origintrail-official/dkg-core';

const observers = new WeakMap<AbortSignal, Set<(frame: BulkGraphFrame) => void>>();
let installedSend: typeof BulkGraphSession.prototype.send | undefined;
let restoreSend: (() => void) | undefined;
afterEach(() => { restoreSend?.(); restoreSend = undefined; installedSend = undefined; });

/** Observe typed requester frames synchronously before the real encoder and Noise transport. */
export function observeOutboundBulkFrames(router: Pick<ProtocolRouter, 'withDuplexStream'>,
  observe: (frame: BulkGraphFrame, peer: string) => void): void {
  if (BulkGraphSession.prototype.send !== installedSend) {
    const send = BulkGraphSession.prototype.send;
    const spy = vi.spyOn(BulkGraphSession.prototype, 'send').mockImplementation(function (this: BulkGraphSession, frame) {
      for (const listener of observers.get(this.signal) ?? []) listener(frame);
      return send.call(this, frame);
    });
    installedSend = spy;
    restoreSend = () => spy.mockRestore();
  }
  const exchange = router.withDuplexStream.bind(router);
  router.withDuplexStream = (peer, protocol, options, consume) =>
    exchange(peer, protocol, options, async (stream, signal) => {
      if (protocol !== BULK_GRAPH_PROTOCOL) return consume(stream, signal);
      const listeners = observers.get(signal) ?? new Set<(frame: BulkGraphFrame) => void>();
      observers.set(signal, listeners);
      const listener = (frame: BulkGraphFrame) => observe(frame, peer);
      listeners.add(listener);
      try { return await consume(stream, signal); }
      finally { listeners.delete(listener); if (!listeners.size) observers.delete(signal); }
    });
}
