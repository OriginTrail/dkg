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

export type DurableRootAtomicCompanionResolver = (
  input: Readonly<DurableRootMaterializationIdentity>,
) => Readonly<DurableRootAtomicCompanion> | undefined;

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
