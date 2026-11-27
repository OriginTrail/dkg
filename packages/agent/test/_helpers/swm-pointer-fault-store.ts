import {
  OxigraphStore,
  type QueryOptions,
  type Quad,
} from '@origintrail-official/dkg-storage';

export const SWM_POINTER_PRED = 'http://dkg.io/ontology/swmCurrentAssertion';

/**
 * The store calls `_stampSwmPointer` makes, by semantic name. `seal-read` and
 * `vm-guard-read` are the two reads; `pointer-delete` / `pointer-insert` are the
 * two halves of the drop-then-set write.
 */
export type SwmPointerFault = 'seal-read' | 'vm-guard-read' | 'pointer-delete' | 'pointer-insert';

/** Fails the next N matching pointer-maintenance store calls, then behaves normally. */
export class SwmPointerFaultStore extends OxigraphStore {
  private armed: { fault: SwmPointerFault; error: Error; remaining: number } | undefined;
  readonly trips: SwmPointerFault[] = [];

  arm(fault: SwmPointerFault, error: Error, times = 1): void {
    this.armed = { fault, error, remaining: times };
  }

  disarm(): void {
    this.armed = undefined;
  }

  private trip(fault: SwmPointerFault): void {
    const armed = this.armed;
    if (armed?.fault !== fault || armed.remaining <= 0) return;
    armed.remaining -= 1;
    this.trips.push(fault);
    throw armed.error;
  }

  override async query(sparql: string, options?: QueryOptions) {
    if (options?.source === 'agent.publish.swmPointerSeal') this.trip('seal-read');
    if (options?.source === 'agent.publish.pointerVmGuard') this.trip('vm-guard-read');
    return super.query(sparql, options);
  }

  override async deleteByPattern(pattern: Partial<Quad>): Promise<number> {
    if (pattern.predicate === SWM_POINTER_PRED) this.trip('pointer-delete');
    return super.deleteByPattern(pattern);
  }

  override async deleteByPatternWithoutCount(pattern: Partial<Quad>): Promise<void> {
    if (pattern.predicate === SWM_POINTER_PRED) this.trip('pointer-delete');
    return super.deleteByPatternWithoutCount(pattern);
  }

  override async insert(quads: Quad[]): Promise<void> {
    if (quads.some((quad) => quad.predicate === SWM_POINTER_PRED)) this.trip('pointer-insert');
    return super.insert(quads);
  }
}
