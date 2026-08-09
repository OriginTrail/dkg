import {
  chunkCopySubjectProjectionInput,
  supportsCopySubjectProjection,
  supportsReplaceSubjectPredicatesAtomically,
  tryCopySubjectProjection,
  tryReplaceSubjectPredicatesAtomically,
  type CopySubjectProjectionInput,
  type ReplaceSubjectPredicatesInput,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { MaterializedVersion } from '@origintrail-official/dkg-publisher';
import { rsHealStoreOptions } from './rs-heal-store-options.js';

export interface RsHealMaterializationInput {
  readonly sourceDataGraphUris: readonly string[];
  readonly targetDataGraphUri: string;
  readonly sourceMetadataGraphUri: string;
  readonly targetMetadataGraphUri: string;
  readonly ual: string;
  readonly roots: readonly string[];
  readonly version: MaterializedVersion;
  readonly materializedVersionPredicate: string;
  readonly dataExcludedPredicates: readonly string[];
}

interface RsHealMaterializationPlan {
  readonly dataCopy: CopySubjectProjectionInput;
  readonly metadataCopy: CopySubjectProjectionInput;
  readonly completionReset: ReplaceSubjectPredicatesInput;
  readonly completionStamp: ReplaceSubjectPredicatesInput;
}

function buildRsHealMaterializationPlan(
  input: RsHealMaterializationInput,
): RsHealMaterializationPlan {
  const completion = {
    graphUri: input.targetMetadataGraphUri,
    subject: input.ual,
    predicates: [input.materializedVersionPredicate],
  };
  return {
    dataCopy: {
      sourceGraphUris: [...input.sourceDataGraphUris],
      targetGraphUri: input.targetDataGraphUri,
      roots: [...input.roots],
      descendantSuffix: '/.well-known/genid/',
      excludedPredicates: [...input.dataExcludedPredicates],
    },
    metadataCopy: {
      sourceGraphUris: [input.sourceMetadataGraphUri],
      targetGraphUri: input.targetMetadataGraphUri,
      roots: [input.ual],
      descendantSuffix: '/',
      excludedPredicates: [input.materializedVersionPredicate],
    },
    completionReset: {
      ...completion,
      replacementQuads: [],
    },
    completionStamp: {
      ...completion,
      replacementQuads: [{
        graph: input.targetMetadataGraphUri,
        subject: input.ual,
        predicate: input.materializedVersionPredicate,
        object: `"${input.version.blockNumber}:${input.version.txIndex}"`,
      }],
    },
  };
}

export function supportsRsHealMaterialization(store: TripleStore): boolean {
  return supportsCopySubjectProjection(store)
    && supportsReplaceSubjectPredicatesAtomically(store);
}

async function copyProjection(
  store: TripleStore,
  input: CopySubjectProjectionInput,
  signal?: AbortSignal,
): Promise<void> {
  const copied = await tryCopySubjectProjection(
    store,
    input,
    rsHealStoreOptions('materialize.copy', signal),
  );
  if (!copied) {
    throw new Error('RS heal requires server-side subject projection copy support');
  }
}

async function replacePredicates(
  store: TripleStore,
  input: ReplaceSubjectPredicatesInput,
  signal?: AbortSignal,
): Promise<void> {
  const replaced = await tryReplaceSubjectPredicatesAtomically(
    store,
    input,
    rsHealStoreOptions('materialize.marker', signal),
  );
  if (!replaced) {
    throw new Error('RS heal requires atomic subject-predicate replacement support');
  }
}

/** Execute one fail-closed RS-heal transition after candidate discovery. */
export async function applyRsHealMaterialization(
  store: TripleStore,
  input: RsHealMaterializationInput,
  canApply: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const plan = buildRsHealMaterializationPlan(input);
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
