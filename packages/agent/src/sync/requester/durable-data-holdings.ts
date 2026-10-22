// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import {
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope,
  type ConfirmedGraphKnowledgeAssetMetadataRead,
} from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { getSyncCheckpointKey } from '../checkpoint/state.js';
import {
  graphScopedDurableManifestPrefixAtOffset,
  type GraphScopedDescriptor,
  type GraphScopedDurableManifestPlan,
} from '../durable-integrity.js';
import {
  markDurableTerminalBoundary,
  recordDurableSyncDiagnostics,
  type DurableSyncAccumulator,
} from '../durable-progress.js';
import { MAX_EXACT_SYNC_ASSETS } from '../exact-assets.js';
import { DEFAULT_DURABLE_DATA_ROUND_BUDGET, type DurableDataRoundBudget } from './durable-data-round.js';
import type { DurableSyncContext } from './durable-sync.js';
import type { SyncPageResult } from './page-fetch.js';

const DKG_NS = 'http://dkg.io/ontology/';

/** The metadata rows `parseConfirmedGraphKnowledgeAssetMetadataEnvelope` reads. */
const ENVELOPE_PREDICATES = [
  'contentScopeVersion', 'assertionVersion', 'publicTripleCount', 'privateTripleCount', 'batchId',
  'merkleRoot', 'privateMerkleRoot', 'assertionGraph', 'kaUal', 'status', 'transactionHash', 'subGraphName',
].map((name) => `${DKG_NS}${name}`);

/** Assets per store read: one VALUES list of exact metadata subjects. */
const HOLDINGS_READ_CHUNK = 200;

export interface HeldGraphScopedAssetsRequest {
  readonly contextGraphId: string;
  readonly descriptors: readonly GraphScopedDescriptor[];
  readonly signal?: AbortSignal;
}

/** An asset of a verified generation that this node does not hold at that version. */
export interface MissingDurableAsset {
  readonly ual: string;
  readonly assertionVersion: string;
}

/**
 * What a graph-owned round and its recovery owner share about the assets this
 * node lacks. The owner fetches a few such assets with exact requests; a round
 * that finds only those missing leaves them to it instead of pulling the graph.
 */
export interface DurableHoldingsChannel {
  /** Set by the owner when it fetches missing assets itself. */
  ownerFetchesMissingAssets?: boolean;
  /** Set by a round that left its missing assets to the owner: one exact request each. */
  missingAssetBatches?: readonly (readonly MissingDurableAsset[])[];
}

export type DurableHoldingsPlan =
  | { readonly kind: 'held'; readonly assets: number }
  | {
      readonly kind: 'fetch-missing';
      readonly held: number;
      readonly batches: readonly (readonly MissingDurableAsset[])[];
      readonly rows: number;
    }
  | { readonly kind: 'full'; readonly held: number };

/**
 * The assets of a verified META generation that this node already holds: a
 * confirmed graph-scoped copy at the descriptor's version, root, row counts
 * and graph, or a confirmed copy at a newer version, which a copy from this
 * peer could not replace. Durable sync verified such a copy against its root
 * and the chain before it wrote the data graph and the metadata in one atomic
 * replacement, so its metadata stands for its rows. That keeps this a
 * metadata read (one store query per chunk of assets), not a content re-hash.
 */
export async function readHeldGraphScopedAssets(
  store: TripleStore,
  request: HeldGraphScopedAssetsRequest,
  chunkSize = HOLDINGS_READ_CHUNK,
): Promise<Set<string>> {
  const metaGraph = assertSafeIri(contextGraphMetaUri(request.contextGraphId));
  const predicates = ENVELOPE_PREDICATES.map((predicate) => `<${predicate}>`).join(' ');
  const held = new Set<string>();
  for (let start = 0; start < request.descriptors.length; start += chunkSize) {
    const chunk = request.descriptors.slice(start, start + chunkSize);
    const subjects = chunk.map((descriptor) => `<${assertSafeIri(descriptor.ual)}>`).join(' ');
    // sparql-scan-allow: R4 -- exact meta graph; subjects and predicates are bound by finite VALUES lists
    const result = await store.query(
      `SELECT ?ual ?predicate ?object WHERE { GRAPH <${metaGraph}> { VALUES ?ual { ${subjects} } VALUES ?predicate { ${predicates} } ?ual ?predicate ?object } }`,
      { priority: 'background', source: 'agent.durableSync.heldAssets', signal: request.signal },
    );
    if (result.type !== 'bindings') throw new Error('Held asset metadata SELECT expected a bindings result');
    const rowsBySubject = new Map<string, Array<{ predicate: string; object: string }>>();
    for (const { ual, predicate, object } of result.bindings) {
      if (ual === undefined || predicate === undefined || object === undefined) {
        throw new Error('Held asset metadata SELECT returned an incomplete binding');
      }
      const rows = rowsBySubject.get(ual) ?? [];
      rows.push({ predicate, object });
      rowsBySubject.set(ual, rows);
    }
    for (const descriptor of chunk) {
      const stored = parseConfirmedGraphKnowledgeAssetMetadataEnvelope(
        rowsBySubject.get(descriptor.ual) ?? [],
        { contextGraphId: request.contextGraphId, ual: descriptor.ual },
      );
      if (holdsDescriptor(descriptor, stored)) held.add(descriptor.ual);
    }
  }
  return held;
}

/** The holdings reader a recovery host gives graph-owned rounds. */
export function heldGraphScopedAssetsReader(
  store: TripleStore,
): (request: HeldGraphScopedAssetsRequest) => Promise<Set<string>> {
  return (request) => readHeldGraphScopedAssets(store, request);
}

function holdsDescriptor(
  descriptor: GraphScopedDescriptor,
  stored: ConfirmedGraphKnowledgeAssetMetadataRead,
): boolean {
  if (stored.state !== 'confirmed') return false;
  const { envelope } = stored;
  const storedVersion = BigInt(envelope.assertionVersion);
  const version = BigInt(descriptor.assertionVersion);
  if (storedVersion !== version) return storedVersion > version;
  return Buffer.from(envelope.merkleRoot).toString('hex') === descriptor.claimedRootHex
    && envelope.assertionGraph === descriptor.assertionGraph
    && envelope.publicTripleCount === descriptor.publicTripleCount
    && envelope.privateTripleCount === descriptor.privateTripleCount
    && (envelope.privateMerkleRoot === undefined
      ? undefined
      : Buffer.from(envelope.privateMerkleRoot).toString('hex')) === descriptor.privateRootHex
    && envelope.subGraphName === descriptor.subGraphName;
}

/**
 * Plan a graph's DATA phase from what this node holds. Everything held: no
 * DATA at all. Part held and the owner fetches missing assets: one exact
 * request per batch of them (at most {@link MAX_EXACT_SYNC_ASSETS} assets and
 * one round's soft row budget). Full-graph rounds fetch, verify and
 * authenticate every held asset again, so exact requests are used while they
 * number fewer than those rounds plus the held assets. Otherwise, as for a
 * first recovery, full-graph rounds.
 */
export function planDurableDataFromHoldings(
  manifest: GraphScopedDurableManifestPlan,
  held: ReadonlySet<string>,
  ownerFetchesMissingAssets: boolean,
  budget: DurableDataRoundBudget = DEFAULT_DURABLE_DATA_ROUND_BUDGET,
): DurableHoldingsPlan {
  const missing = manifest.descriptors.filter((descriptor) => !held.has(descriptor.ual));
  if (missing.length === 0) return { kind: 'held', assets: manifest.descriptors.length };
  const heldAssets = manifest.descriptors.length - missing.length;
  if (!ownerFetchesMissingAssets || heldAssets === 0) return { kind: 'full', held: heldAssets };

  const batches: MissingDurableAsset[][] = [];
  let batchRows = 0;
  for (const descriptor of missing) {
    const asset = { ual: descriptor.ual, assertionVersion: descriptor.assertionVersion };
    const current = batches.at(-1);
    if (
      current === undefined
      || current.length >= MAX_EXACT_SYNC_ASSETS
      || batchRows + descriptor.publicTripleCount > budget.softRows
    ) {
      batches.push([asset]);
      batchRows = descriptor.publicTripleCount;
    } else {
      current.push(asset);
      batchRows += descriptor.publicTripleCount;
    }
  }
  const fullGraphRounds = Math.max(1, Math.ceil(manifest.manifestRowCount / budget.softRows));
  if (batches.length >= fullGraphRounds + heldAssets) return { kind: 'full', held: heldAssets };
  return {
    kind: 'fetch-missing',
    held: heldAssets,
    batches,
    rows: missing.reduce((rows, descriptor) => rows + descriptor.publicTripleCount, 0),
  };
}

/**
 * Plan a graph-owned round's DATA phase once its META generation is verified,
 * and leave a `fetch-missing` plan to the owner. A failed store read plans
 * nothing: the round then runs its bounded full-graph rounds as before.
 */
export async function planDurableDataFromLocalHoldings(input: {
  readonly contextGraphId: string;
  readonly manifest: GraphScopedDurableManifestPlan;
  readonly channel: DurableHoldingsChannel;
  readonly readHeld: NonNullable<DurableSyncContext['readHeldGraphScopedAssets']>;
  readonly signal?: AbortSignal;
  readonly logWarn: (message: string) => void;
}): Promise<DurableHoldingsPlan | undefined> {
  const { contextGraphId, manifest, channel } = input;
  let held: ReadonlySet<string>;
  try {
    held = await input.readHeld({ contextGraphId, descriptors: manifest.descriptors, signal: input.signal });
  } catch (error) {
    input.signal?.throwIfAborted();
    input.logWarn(
      `Could not read which assets of "${contextGraphId}" this node holds; fetching the graph: `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  const plan = planDurableDataFromHoldings(manifest, held, channel.ownerFetchesMissingAssets === true);
  if (plan.kind === 'fetch-missing') channel.missingAssetBatches = plan.batches;
  return plan;
}

/**
 * Settle a DATA phase whose whole generation this node already holds: persist
 * the terminal boundary for this peer, as a completed round would, and count
 * the phase as resumed at that boundary and completed. No row is fetched.
 */
export function settleHeldDurableData(input: {
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly manifest: GraphScopedDurableManifestPlan;
  readonly accumulator: DurableSyncAccumulator;
  readonly deleteCheckpoint: DurableSyncContext['deleteCheckpoint'];
  readonly setCheckpoint: DurableSyncContext['setCheckpoint'];
}): void {
  const { manifest } = input;
  const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, manifest.manifestRowCount);
  if (!prefix) throw new Error(`Held durable manifest of "${input.contextGraphId}" has no terminal boundary`);
  const checkpointKey = getSyncCheckpointKey(input.remotePeerId, input.contextGraphId, false, 'data');
  // Drop a responder session first: its raw coordinate belongs to an earlier round.
  input.deleteCheckpoint(checkpointKey);
  input.setCheckpoint(checkpointKey, {
    offset: manifest.manifestRowCount,
    binding: { manifestDigest: manifest.manifestDigest, manifestPrefixDigest: prefix.prefixDigest, terminal: true },
  });
  recordDurableSyncDiagnostics(input.accumulator, { resumedPhases: 1, completedPhases: 1 });
}

/**
 * Settle a round whose DATA phase a holdings plan replaced: count its META
 * fetch, and settle a held generation with {@link settleHeldDurableData},
 * which makes the round complete. A fetch-missing round stays incomplete; the
 * owner fetches what it left. Returns the round's log line.
 */
export function settleDurableDataFromHoldings(input: Parameters<typeof settleHeldDurableData>[0] & {
  readonly plan: Exclude<DurableHoldingsPlan, { kind: 'full' }>;
  readonly metaResult: Pick<SyncPageResult, 'bytesReceived' | 'quads'>;
}): string {
  const { plan, metaResult, accumulator } = input;
  recordDurableSyncDiagnostics(accumulator, {
    bytesReceived: metaResult.bytesReceived,
    fetchedMetaTriples: metaResult.quads.length,
  });
  if (plan.kind === 'held') settleHeldDurableData(input);
  markDurableTerminalBoundary(accumulator, plan.kind === 'held');
  return describeDurableHoldingsPlan(input.contextGraphId, input.manifest, plan);
}

export function describeDurableHoldingsPlan(
  contextGraphId: string,
  manifest: GraphScopedDurableManifestPlan,
  plan: Exclude<DurableHoldingsPlan, { kind: 'full' }>,
): string {
  return plan.kind === 'held'
    ? `Durable data for "${contextGraphId}" is already held at this META generation `
      + `(${plan.assets} assets, ${manifest.manifestRowCount} rows): skipping the DATA phase`
    : `Durable data for "${contextGraphId}": ${plan.held} of ${manifest.descriptors.length} assets already held; `
      + `leaving ${manifest.descriptors.length - plan.held} asset(s) (${plan.rows} rows) `
      + `to ${plan.batches.length} exact request(s)`;
}
