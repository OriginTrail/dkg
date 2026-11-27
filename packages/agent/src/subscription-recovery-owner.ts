// SPDX-License-Identifier: Apache-2.0

export interface SubscriptionRecoveryLease {
  readonly signal: AbortSignal;
  /** A superseded activation must finish compensating before its successor starts. */
  readonly ready: Promise<void>;
  isCurrent(): boolean;
  release(): void;
}
interface HeldRecovery {
  priority: number;
  controller: AbortController;
  retired: Promise<void>;
}

/** One graph owner across paced recovery, startup retry and verified ACK demand.
 * Schedulers retain their own bounds/backoff; a higher-priority request replaces
 * the pending owner and aborts its authority read before taking over. */
export class SubscriptionRecoveryCoordinator {
  readonly #held = new Map<string, HeldRecovery>();
  has(id: string): boolean { return this.#held.has(id); }
  claim(id: string, priority: number, signal: AbortSignal): SubscriptionRecoveryLease | undefined {
    if (signal.aborted) return undefined;
    const previous = this.#held.get(id);
    if (previous && previous.priority >= priority) return undefined;
    const controller = new AbortController();
    let retire!: () => void;
    const held: HeldRecovery = { priority, controller, retired: new Promise(resolve => { retire = resolve; }) };
    const stop = () => controller.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    this.#held.set(id, held);
    previous?.controller.abort(new Error('Subscription recovery upgraded'));
    let released = false;
    return {
      signal: controller.signal,
      ready: previous?.retired ?? Promise.resolve(),
      isCurrent: () => !released && !controller.signal.aborted && this.#held.get(id) === held,
      release: () => {
        if (released) return;
        released = true;
        signal.removeEventListener('abort', stop);
        if (this.#held.get(id) === held) this.#held.delete(id);
        retire();
      },
    };
  }
}

const coordinators = new WeakMap<object, SubscriptionRecoveryCoordinator>();
export function subscriptionRecoveryCoordinatorOf(owner: object): SubscriptionRecoveryCoordinator {
  let coordinator = coordinators.get(owner);
  if (!coordinator) { coordinator = new SubscriptionRecoveryCoordinator(); coordinators.set(owner, coordinator); }
  return coordinator;
}
