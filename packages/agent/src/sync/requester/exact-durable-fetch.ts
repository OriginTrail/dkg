import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from './page-fetch.js';

const DKG_NS = 'http://dkg.io/ontology/';
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;

export type ExactDurableFetchDisposition = 'found' | 'clean-absent' | 'incomplete';

/**
 * Rolling-upgrade guard: an old responder may ignore the additive exact-asset
 * filter and return the whole CG. Keep only requested descriptor subjects and
 * their declared assertion graphs before any verification or store write.
 */
export function filterExactAssetDurablePayload(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
  assetUals: readonly string[],
): { dataQuads: Quad[]; metaQuads: Quad[]; descriptorCoverageComplete: boolean } {
  const exactUals = new Set(assetUals);
  const exactMeta = metaQuads.filter((quad) => exactUals.has(quad.subject));
  const returnedDescriptors = new Set(
    exactMeta
      .filter((quad) => (
        quad.predicate === KA_UAL
        && quad.subject === stripLiteral(quad.object)
      ))
      .map((quad) => quad.subject),
  );
  const exactGraphs = new Set(
    exactMeta
      .filter((quad) => quad.predicate === ASSERTION_GRAPH)
      .map((quad) => quad.object),
  );
  return {
    metaQuads: exactMeta,
    dataQuads: dataQuads.filter((quad) => exactGraphs.has(quad.graph)),
    descriptorCoverageComplete: returnedDescriptors.size === exactUals.size
      && [...exactUals].every((ual) => returnedDescriptors.has(ual)),
  };
}

export function classifyExactDurableFetch(params: {
  requestedAssetCount: number;
  metaResult: SyncPageResult;
  dataResult: SyncPageResult;
  metaFetched: boolean;
  descriptorCoverageComplete: boolean;
  rejectedKcs: number;
  dataRejectedMissingMeta: number;
}): ExactDurableFetchDisposition {
  const cleanPhase = (phase: SyncPageResult) => (
    phase.completed
    && !phase.timedOut
    && phase.nextOffset >= phase.resumedFromOffset
  );
  if (
    params.requestedAssetCount === 0
    || !params.metaFetched
    || !cleanPhase(params.metaResult)
    || !cleanPhase(params.dataResult)
    || params.rejectedKcs !== 0
    || params.dataRejectedMissingMeta !== 0
  ) return 'incomplete';

  const freshEmptyPhase = (phase: SyncPageResult) => (
    phase.responderSessionStartedFresh === true
    && phase.resumedFromOffset === 0
    && phase.nextOffset === 0
    && phase.quads.length === 0
  );
  if (freshEmptyPhase(params.metaResult) && freshEmptyPhase(params.dataResult)) {
    return 'clean-absent';
  }

  return params.descriptorCoverageComplete ? 'found' : 'incomplete';
}

export function mergeExactDurableFetchDisposition(
  current: ExactDurableFetchDisposition | undefined,
  next: ExactDurableFetchDisposition,
): ExactDurableFetchDisposition {
  if (current === undefined) return next;
  if (current === 'incomplete' || next === 'incomplete') return 'incomplete';
  if (current === 'found' || next === 'found') return 'found';
  return 'clean-absent';
}

function stripLiteral(raw: string): string {
  const match = raw.match(/^"(.*)"(?:\^\^.*|@.*)?$/);
  return match ? match[1]! : raw;
}
