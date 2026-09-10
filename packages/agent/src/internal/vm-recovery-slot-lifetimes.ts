import type { OrdinalRecoveryTarget } from '../chain-reconciler.js';

type Target = Pick<OrdinalRecoveryTarget, 'localCgId' | 'onChainCgId' | 'ordinal' | 'ual' | 'merkleRoot'>;

export function vmRecoverySlotKey(target: Pick<Target, 'localCgId' | 'onChainCgId' | 'ordinal'>): string {
  return `${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}`;
}

export function vmRecoveryTargetFingerprint(target: Pick<Target, 'ual' | 'merkleRoot'>): string {
  return `${target.ual}\0${target.merkleRoot.toLowerCase()}`;
}

interface SlotGeneration {
  readonly localCgId: string;
  readonly fingerprint: string;
  readonly controller: AbortController;
  users: number;
}

export interface VmRecoverySlotScope {
  readonly signal: AbortSignal;
  /** Attach the selected targets after proof-cache preparation, including unowned fallback targets. */
  track(targets: readonly Target[]): void;
  release(): void;
}

/** Cancellation belongs to active slot generations, independently of cached absence evidence. */
export class VmRecoverySlotLifetimes {
  private readonly slots = new Map<string, SlotGeneration>();

  begin(): VmRecoverySlotScope {
    const controller = new AbortController();
    const held = new Map<string, { generation: SlotGeneration; onAbort: () => void }>();
    let released = false;
    return {
      signal: controller.signal,
      track: targets => {
        if (released || controller.signal.aborted) return;
        for (const target of targets) {
          this.observe(target);
          if (controller.signal.aborted) break;
          const key = vmRecoverySlotKey(target);
          if (held.has(key)) continue;
          let generation = this.slots.get(key);
          if (!generation) {
            generation = {
              localCgId: target.localCgId,
              fingerprint: vmRecoveryTargetFingerprint(target),
              controller: new AbortController(), users: 0,
            };
            this.slots.set(key, generation);
          }
          const retained = generation;
          const onAbort = () => controller.abort(retained.controller.signal.reason);
          held.set(key, { generation, onAbort });
          generation.users++;
          generation.controller.signal.addEventListener('abort', onAbort, { once: true });
        }
      },
      release: () => {
        if (released) return;
        released = true;
        for (const [key, { generation, onAbort }] of held) {
          generation.controller.signal.removeEventListener('abort', onAbort);
          generation.users--;
          if (generation.users === 0 && this.slots.get(key) === generation) this.slots.delete(key);
        }
        held.clear();
      },
    };
  }

  /** Observing a replacement fingerprint invalidates only the superseded generation. */
  observe(target: Target): void {
    const key = vmRecoverySlotKey(target);
    const generation = this.slots.get(key);
    if (generation && generation.fingerprint !== vmRecoveryTargetFingerprint(target)) this.invalidateSlot(key);
  }

  invalidateSlot(key: string): void {
    const generation = this.slots.get(key);
    if (!generation) return;
    this.slots.delete(key);
    generation.controller.abort();
  }

  invalidateContextGraph(localCgId: string): void {
    // Abort listeners run synchronously and can acquire a new generation.
    const generations = [...this.slots];
    for (const [key, generation] of generations) {
      if (generation.localCgId === localCgId) this.invalidateSlot(key);
    }
  }

  close(): void {
    const keys = [...this.slots.keys()];
    for (const key of keys) this.invalidateSlot(key);
  }
}
