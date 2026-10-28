// SPDX-License-Identifier: Apache-2.0
import type { Rfc64CatalogReplayScopeLifecycleV1 as Scope } from './catalog-replay-scope-lifecycle-v1.js';

/** Owns bounded scheduling membership; completeness leases remain with scopes. */
export class Rfc64CatalogReplaySchedulingWindowV1 {
  readonly #members = new Set<Scope>();
  readonly #waiting = new Set<Scope>();
  readonly #yieldedCooldown = new WeakMap<Scope, number>();
  #snapshot: Readonly<{ runnable: readonly Scope[]; nextWake: number }> = Object.freeze({ runnable: [], nextWake: Infinity });
  get snapshot(): Readonly<{ runnable: readonly Scope[]; nextWake: number }> { return this.#snapshot; }
  constructor(readonly capacity = 256) {}

  add(scope: Scope): void {
    if (this.#members.has(scope) || this.#waiting.has(scope)) return;
    if (this.#members.size < this.capacity) this.#members.add(scope);
    else this.#waiting.add(scope);
  }
  remove(scope: Scope): void { this.#members.delete(scope); this.#waiting.delete(scope); }

  #advance(now: number): void {
    for (const scope of this.#members) {
      const cooled = scope.eligibleAt !== 0 && scope.eligibleAt <= now;
      if ((scope.outstanding === 0 && scope.eligibleAt <= now)
        || (cooled && scope.ready(now) && this.#yieldedCooldown.get(scope) !== scope.eligibleAt)) {
        this.#members.delete(scope);
        this.#yieldedCooldown.set(scope, scope.eligibleAt);
        this.#waiting.add(scope);
      }
    }
    // Promote ready overflow before another cooled reconnect. Set insertion
    // order carries a yielded member behind the scopes already waiting.
    const waiting = [...this.#waiting];
    for (const scope of [...waiting.filter(scope => scope.ready(now)),
      ...waiting.filter(scope => !scope.ready(now) && scope.outstanding > 0)]) {
      if (this.#members.size === this.capacity) break;
      this.#waiting.delete(scope);
      this.#members.add(scope);
      if (scope.eligibleAt <= now) this.#yieldedCooldown.set(scope, scope.eligibleAt);
    }
  }

  /** The only scheduling transition; inspection consumes this immutable view. */
  refresh(now: number): void {
    this.#advance(now);
    const all = [...this.#members, ...this.#waiting];
    const waiting = all.some(scope => scope.queued || scope.awaitingFence());
    const stalled = waiting && ![...this.#members].some(scope => scope.ready(now));
    let deadline = stalled || all.some(scope => scope.awaitingFence()) ? now + 1_000 : Infinity;
    for (const scope of this.#members) {
      // Completed members retain their position through cooldown; its expiry
      // is a wakeup when it is the only obstacle to promoting overflow.
      if ((scope.queued || (stalled && scope.outstanding === 0)) && scope.eligibleAt > now) {
        deadline = Math.min(deadline, scope.eligibleAt);
      }
    }
    this.#snapshot = Object.freeze({ runnable: Object.freeze([...this.#members].filter(scope => scope.ready(now))), nextWake: deadline });
  }
}
