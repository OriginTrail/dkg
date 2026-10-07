import {
  tryReplaceGraphAndSubjectAtomically,
  tryReplaceGraphAtomically,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

/** Stable identity available at every validated root-SWM materialization seam. */
export interface DurableRootMaterializationIdentity {
  readonly contextGraphId: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly shareOperationId: string;
}

/** One metadata subject that must share the root SWM graph's atomic commit. */
export interface DurableRootAtomicCompanion {
  readonly graphUri: string;
  readonly subject: string;
  readonly quads: readonly Quad[];
  /**
   * `true` is a known compound commit, `false` a clean capability refusal,
   * and `undefined` preserves conservative state after indeterminate dispatch.
   */
  readonly settle?: (committed: boolean | undefined) => void;
}

export interface DurableRootAtomicCompanionResolver {
  (input: Readonly<DurableRootMaterializationIdentity>): Readonly<DurableRootAtomicCompanion> | undefined;
  /** See {@link DurableRootCompanionAdmissionWait}. */
  readonly awaitAdmission?: DurableRootCompanionAdmissionWait;
}

/**
 * Optional companion of a resolver that can refuse a root write for a reason
 * that passes on its own. It resolves once the resolver would admit this
 * asset, or when its own short bound ends; it never rejects and reserves
 * nothing, so the resolver may still refuse afterwards. A seam that can wait
 * calls it right before the synchronous resolve.
 */
export type DurableRootCompanionAdmissionWait = (
  input: Readonly<Pick<DurableRootMaterializationIdentity, 'contextGraphId' | 'kaUal'>>,
) => Promise<void>;

/**
 * Replace an exact graph and, when present, its durable companion as one store
 * transaction. The resolver-side lease is always settled with the strongest
 * outcome the storage adapter proved.
 */
export async function tryReplaceGraphWithDurableRootCompanionAtomically(
  store: TripleStore,
  graphUri: string,
  quads: readonly Quad[],
  companion: Readonly<DurableRootAtomicCompanion> | undefined,
  options?: QueryOptions,
): Promise<boolean> {
  if (companion === undefined) {
    return tryReplaceGraphAtomically(store, graphUri, [...quads], options);
  }

  let outcome: boolean | undefined = false;
  try {
    // Once dispatched, a rejection may describe either complete atomic
    // outcome. Only an explicit false is a proven preflight non-commit.
    outcome = undefined;
    const replaced = await tryReplaceGraphAndSubjectAtomically(
      store,
      graphUri,
      [...quads],
      companion.graphUri,
      companion.subject,
      companion.quads.map((quad) => ({ ...quad })),
      options,
    );
    outcome = replaced;
    return replaced;
  } finally {
    companion.settle?.(outcome);
  }
}
