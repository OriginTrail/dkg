import {
  chunkCopySubjectProjectionInput,
  supportsCopySubjectProjection,
  supportsReplaceSubjectPredicatesAtomically,
  tryCopySubjectProjection,
  tryReplaceSubjectPredicatesAtomically,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

type RsHealCopyInput = Parameters<typeof tryCopySubjectProjection>[1];
type RsHealPredicateReplacement = Parameters<typeof tryReplaceSubjectPredicatesAtomically>[1];

export interface RsHealMaterializationPlan {
  readonly dataCopy: RsHealCopyInput;
  readonly metadataCopy: RsHealCopyInput;
  readonly completionReset: RsHealPredicateReplacement;
  readonly completionStamp: RsHealPredicateReplacement;
}

function storeOptions(operation: 'copy' | 'marker', signal?: AbortSignal): QueryOptions {
  return {
    priority: 'background',
    source: `agent.swm.rsHeal.materialize.${operation}`,
    ...(signal ? { signal } : {}),
  };
}

export function supportsRsHealMaterialization(store: TripleStore): boolean {
  return supportsCopySubjectProjection(store)
    && supportsReplaceSubjectPredicatesAtomically(store);
}

async function copyProjection(
  store: TripleStore,
  input: RsHealCopyInput,
  signal?: AbortSignal,
): Promise<void> {
  const copied = await tryCopySubjectProjection(store, input, storeOptions('copy', signal));
  if (!copied) {
    throw new Error('RS heal requires server-side subject projection copy support');
  }
}

async function replacePredicates(
  store: TripleStore,
  input: RsHealPredicateReplacement,
  signal?: AbortSignal,
): Promise<void> {
  const replaced = await tryReplaceSubjectPredicatesAtomically(
    store,
    input,
    storeOptions('marker', signal),
  );
  if (!replaced) {
    throw new Error('RS heal requires atomic subject-predicate replacement support');
  }
}

/** Execute one fail-closed RS-heal transition after candidate discovery. */
export async function applyRsHealMaterialization(
  store: TripleStore,
  plan: RsHealMaterializationPlan,
  canApply: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  // Validate and chunk the complete data plan before crossing the first write
  // boundary. An unrepresentable root must not clear a valid completion marker.
  const dataCopyChunks = chunkCopySubjectProjectionInput(plan.dataCopy);

  if (!canApply()) return;
  await replacePredicates(store, plan.completionReset, signal);

  for (const chunk of dataCopyChunks) {
    if (!canApply()) return;
    await copyProjection(store, chunk, signal);
  }

  if (!canApply()) return;
  await copyProjection(store, plan.metadataCopy, signal);
  if (!canApply()) return;
  await replacePredicates(store, plan.completionStamp, signal);
}
