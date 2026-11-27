// SPDX-License-Identifier: Apache-2.0
/** Shared physical transport custody: at most two operations, one per peer.
 * Aborting a caller never releases a running operation's slot before it exits.
 */
export class CatalogReplayPeerLaneV1 {
  readonly #active = new Set<string>();
  readonly #queued: { peer: string; start(): void }[] = [];
  run<T>(peer: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const abort = () => {
        const index = this.#queued.indexOf(entry);
        if (index < 0) return;
        this.#queued.splice(index, 1); reject(signal?.reason); this.#drain();
      };
      const entry = { peer, start: () => {
        signal?.removeEventListener('abort', abort);
        this.#active.add(peer);
        Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); })
          .then(resolve, reject).finally(() => { this.#active.delete(peer); this.#drain(); });
      } };
      this.#queued.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
      this.#drain();
    });
  }
  #drain(): void {
    while (this.#active.size < 2) {
      const index = this.#queued.findIndex(entry => !this.#active.has(entry.peer));
      if (index < 0) return;
      this.#queued.splice(index, 1)[0]!.start();
    }
  }
}
