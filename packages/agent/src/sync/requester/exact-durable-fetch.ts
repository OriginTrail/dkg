import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from './page-fetch.js';
import { stripLiteral } from '../../dkg-agent-utils.js';

const DKG_NS = 'http://dkg.io/ontology/';
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;
const MERKLE_ROOT = `${DKG_NS}merkleRoot`;
const PUBLIC_TRIPLE_COUNT = `${DKG_NS}publicTripleCount`;
const PRIVATE_TRIPLE_COUNT = `${DKG_NS}privateTripleCount`;

export type ExactDurableFetchDisposition = 'found' | 'clean-absent' | 'incomplete';

/** Challenge-pinned identity an exact fetch must match before materialization. */
export interface ExactAssetCommitment {
  readonly assetUal: string;
  readonly merkleRootHex: string;
  /** Structured V10 leaf count: public triples plus one private-root sibling. */
  readonly merkleLeafCount: bigint;
}

function descriptorMatchesCommitment(
  metaQuads: readonly Quad[],
  commitment: ExactAssetCommitment,
): boolean {
  const rows = metaQuads.filter((quad) => quad.subject === commitment.assetUal);
  const values = (predicate: string) => [...new Set(
    rows.filter((quad) => quad.predicate === predicate).map((quad) => stripLiteral(quad.object)),
  )];
  const roots = values(MERKLE_ROOT).map((root) => root.toLowerCase());
  const publicCounts = values(PUBLIC_TRIPLE_COUNT);
  const privateCounts = values(PRIVATE_TRIPLE_COUNT);
  if (roots.length !== 1 || publicCounts.length !== 1 || privateCounts.length !== 1) return false;
  try {
    const publicCount = BigInt(publicCounts[0]!);
    const privateCount = BigInt(privateCounts[0]!);
    const leafCount = publicCount + (privateCount > 0n ? 1n : 0n);
    return roots[0] === commitment.merkleRootHex.toLowerCase()
      && leafCount === commitment.merkleLeafCount;
  } catch {
    return false;
  }
}

/**
 * Rolling-upgrade guard: an old responder may ignore the additive exact-asset
 * filter and return the whole CG. Keep only requested descriptor subjects and
 * their declared assertion graphs before any verification or store write.
 */
export function filterExactAssetDurablePayload(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
  assetUals: readonly string[],
  expectedCommitments?: readonly ExactAssetCommitment[],
): { dataQuads: Quad[]; metaQuads: Quad[]; descriptorCoverageComplete: boolean } {
  const exactUals = new Set(assetUals);
  const commitments = new Map(
    expectedCommitments?.map((commitment) => [commitment.assetUal, commitment]) ?? [],
  );
  const admittedUals = new Set([...exactUals].filter((ual) => {
    const commitment = commitments.get(ual);
    return commitment === undefined || descriptorMatchesCommitment(metaQuads, commitment);
  }));
  const exactMeta = metaQuads.filter((quad) => admittedUals.has(quad.subject));
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
    descriptorCoverageComplete: admittedUals.size === exactUals.size
      && returnedDescriptors.size === exactUals.size
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
