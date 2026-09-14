import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from './page-fetch.js';
import { stripLiteral } from '../../dkg-agent-utils.js';
import { parseGraphScopedDescriptor } from '../durable-integrity.js';
import {
  exactAssetCommitmentMatchesDescriptor,
  exactAssetCommitmentsForSelection,
  exactAssetUalsForSelection,
  type ExactAssetSelection,
} from '../exact-assets.js';

const DKG_NS = 'http://dkg.io/ontology/';
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;

export type ExactDurableFetchDisposition = 'found' | 'clean-absent' | 'incomplete';

/**
 * Capability evidence derived from a completed exact request. The only
 * negative capability is deliberately exposed: a responder that returned a
 * bounded, clean prefix without the requested descriptor cannot satisfy a
 * future exact request on the same connection.
 */
export type ExactAssetResponderCapability = 'legacy-filter-unsupported';

export type ExactAssetFetchSessionPolicy =
  | Readonly<{
      kind: 'durable-materialization';
      forceFreshSession: false;
      allowDurableCheckpoints: true;
      requesterScope?: never;
    }>
  | Readonly<{
      kind: 'ephemeral-challenge';
      forceFreshSession: true;
      allowDurableCheckpoints: false;
      requesterScope: `challenge-exact:${string}`;
    }>;

/** Keep exact retrieval semantics next to filtering and completion policy. */
export function exactAssetFetchSessionPolicy(
  selection: ExactAssetSelection,
): ExactAssetFetchSessionPolicy {
  if (selection.kind === 'ual-only') {
    return {
      kind: 'durable-materialization',
      forceFreshSession: false,
      allowDurableCheckpoints: true,
    };
  }
  return {
    kind: 'ephemeral-challenge',
    forceFreshSession: true,
    allowDurableCheckpoints: false,
    requesterScope: `challenge-exact:${selection.commitments
      .map((commitment) => `${commitment.merkleRootHex}:${commitment.merkleLeafCount}`)
      .join('.')}`,
  };
}

function descriptorMatchesCommitment(
  metaQuads: readonly Quad[],
  commitment: NonNullable<ReturnType<typeof exactAssetCommitmentsForSelection>>[number],
): boolean {
  const rows = metaQuads.filter((quad) => quad.subject === commitment.assetUal);
  try {
    return exactAssetCommitmentMatchesDescriptor(
      commitment,
      parseGraphScopedDescriptor(commitment.assetUal, rows),
    );
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
  selection: ExactAssetSelection,
): {
  dataQuads: Quad[];
  metaQuads: Quad[];
  descriptorCoverageComplete: boolean;
  missingDescriptorUals: string[];
  mismatchedDescriptorUals: string[];
} {
  const assetUals = exactAssetUalsForSelection(selection);
  const exactUals = new Set(assetUals);
  const commitments = new Map(
    exactAssetCommitmentsForSelection(selection)
      ?.map((commitment) => [commitment.assetUal, commitment]) ?? [],
  );
  const mismatchedDescriptorUals: string[] = [];
  const admittedUals = new Set([...exactUals].filter((ual) => {
    const commitment = commitments.get(ual);
    if (commitment === undefined) return true;
    const descriptorRows = metaQuads.filter((quad) => quad.subject === ual);
    if (descriptorRows.length === 0) return false;
    if (descriptorMatchesCommitment(descriptorRows, commitment)) return true;
    mismatchedDescriptorUals.push(ual);
    return false;
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
  const missingDescriptorUals = [...exactUals].filter((ual) => (
    !mismatchedDescriptorUals.includes(ual)
    && !returnedDescriptors.has(ual)
  ));
  return {
    metaQuads: exactMeta,
    dataQuads: dataQuads.filter((quad) => exactGraphs.has(quad.graph)),
    descriptorCoverageComplete:
      missingDescriptorUals.length === 0 && mismatchedDescriptorUals.length === 0,
    missingDescriptorUals,
    mismatchedDescriptorUals,
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
  if (
    params.requestedAssetCount === 0
    || !params.metaFetched
    || !isCleanExactPhase(params.metaResult)
    || !isCleanExactPhase(params.dataResult)
    || params.rejectedKcs !== 0
    || params.dataRejectedMissingMeta !== 0
  ) return 'incomplete';

  if (isFreshEmptyExactPhase(params.metaResult) && isFreshEmptyExactPhase(params.dataResult)) {
    return 'clean-absent';
  }

  return params.descriptorCoverageComplete ? 'found' : 'incomplete';
}

/**
 * Detect the rolling-upgrade case where an older responder ignored the
 * additive exact filter and returned a clean bounded prefix that omitted the
 * requested descriptor. Fresh empty exact responses remain ordinary clean
 * absence; incomplete, rejected, or challenge-pinned responses do not produce
 * capability evidence.
 */
export function classifyExactAssetResponderCapability(params: {
  requestedAssetCount: number;
  metaResult: SyncPageResult;
  dataResult: SyncPageResult;
  metaFetched: boolean;
  descriptorCoverageComplete: boolean;
  rejectedKcs: number;
  dataRejectedMissingMeta: number;
}): ExactAssetResponderCapability | undefined {
  if (
    params.requestedAssetCount === 0
    || !params.metaFetched
    || !isCleanExactPhase(params.metaResult)
    || !isCleanExactPhase(params.dataResult)
    || params.rejectedKcs !== 0
    || params.dataRejectedMissingMeta !== 0
    || params.descriptorCoverageComplete
    || (isFreshEmptyExactPhase(params.metaResult) && isFreshEmptyExactPhase(params.dataResult))
  ) return undefined;
  return 'legacy-filter-unsupported';
}

function isCleanExactPhase(phase: SyncPageResult): boolean {
  return phase.completed
    && !phase.timedOut
    && phase.nextOffset >= phase.resumedFromOffset;
}

function isFreshEmptyExactPhase(phase: SyncPageResult): boolean {
  return phase.responderSessionStartedFresh === true
    && phase.resumedFromOffset === 0
    && phase.nextOffset === 0
    && phase.quads.length === 0;
}

export function mergeExactAssetResponderCapability(
  current: ExactAssetResponderCapability | undefined,
  next: ExactAssetResponderCapability | undefined,
): ExactAssetResponderCapability | undefined {
  return current ?? next;
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
