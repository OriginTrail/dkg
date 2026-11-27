// SPDX-License-Identifier: Apache-2.0

import type { OntologyBindingSlotClass } from '@origintrail-official/dkg-core';
import { runBoundedOperation } from './bounded-operation.js';
import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';

/** How long a slot that read not live is answered from memory. */
export const ONTOLOGY_BINDING_SLOT_RECHECK_MS = 5 * 60_000;
/** Most slots remembered at once; the oldest is forgotten first. */
export const ONTOLOGY_BINDING_SLOTS_MAX = 1024;

/** The chain reads a classification needs; either may be missing. */
export interface OntologyBindingSlotReads {
  readonly isActive?: (slot: bigint, signal: AbortSignal) => Promise<boolean>;
  /** 0 public, 1 curated; 0 also for a slot this node's RPC can't see. */
  readonly accessPolicy?: (slot: bigint, signal: AbortSignal) => Promise<number>;
}

export interface OntologyBindingSlotClassifierOptions {
  /** The chain reads, looked up for each classification. */
  readonly reads: () => OntologyBindingSlotReads;
  /** Whether another check already read this slot's policy as curated. */
  readonly knownCurated: (onChainId: string) => boolean;
  /** Deadline for each chain read. */
  readonly readTimeoutMs: () => number;
  readonly now?: () => number;
}

type SlotState =
  | { readonly slotClass: 'curated' | 'public' }
  | { readonly slotClass: 'inactive'; readonly recheckAt: number };

/**
 * Classifies the on-chain slot an ontology binding names.
 *
 * The policy getter answers 0 for a slot this node's RPC can't see yet, so 0
 * proves a public graph only after the slot reads live. 1 is never a
 * default, so it proves a curated graph even when the slot isn't live. The
 * access policy is fixed at creation, so proven classes are kept. A slot
 * that reads 0 and not live is `inactive` and isn't read again for a while;
 * `inactive` and `unknown` prove nothing. Each read has a deadline, and a
 * read that fails or runs out of time answers `unknown`.
 */
export class OntologyBindingSlotClassifier {
  private readonly slots = new Map<string, SlotState>();
  private readonly now: () => number;

  constructor(private readonly options: OntologyBindingSlotClassifierOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** The class this node already knows without a chain read, if any. */
  known(onChainId: string): OntologyBindingSlotClass | undefined {
    const state = this.slots.get(onChainId);
    if (state !== undefined && state.slotClass !== 'inactive') return state.slotClass;
    if (this.options.knownCurated(onChainId)) return 'curated';
    if (state === undefined) return undefined;
    if (this.now() < state.recheckAt) return 'inactive';
    this.slots.delete(onChainId);
    return undefined;
  }

  async classify(onChainId: string): Promise<OntologyBindingSlotClass> {
    const known = this.known(onChainId);
    if (known !== undefined) return known;
    const { isActive, accessPolicy } = this.options.reads();
    if (!isActive || !accessPolicy || !isCanonicalAuthoritativeContextGraphId(onChainId)) return 'unknown';
    const slot = BigInt(onChainId);
    try {
      // Liveness first: the policy read that follows a live read is the slot's own.
      const live = await this.read(`isContextGraphActiveOnChain(${onChainId})`, (signal) => isActive(slot, signal));
      const policy = await this.read(`getContextGraphAccessPolicy(${onChainId})`, (signal) => accessPolicy(slot, signal));
      if (policy === 1 || (policy === 0 && live)) {
        const slotClass = policy === 1 ? 'curated' : 'public';
        this.remember(onChainId, { slotClass });
        return slotClass;
      }
      if (policy !== 0) return 'unknown';
      this.remember(onChainId, { slotClass: 'inactive', recheckAt: this.now() + ONTOLOGY_BINDING_SLOT_RECHECK_MS });
      return 'inactive';
    } catch {
      return 'unknown';
    }
  }

  private read<T>(label: string, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return runBoundedOperation(start, { label, timeoutMs: this.options.readTimeoutMs() });
  }

  private remember(onChainId: string, state: SlotState): void {
    this.slots.delete(onChainId);
    if (this.slots.size >= ONTOLOGY_BINDING_SLOTS_MAX) {
      const oldest = this.slots.keys().next().value;
      if (oldest !== undefined) this.slots.delete(oldest);
    }
    this.slots.set(onChainId, state);
  }
}
