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
import { mapWithConcurrencyDrained } from '../../map-with-concurrency.js';
import { DEFAULT_DURABLE_DATA_ROUND_BUDGET, type DurableDataRoundBudget } from './durable-data-round.js';
import type { DurableSyncContext } from './durable-sync.js';
import type { GraphScopedAssetChainState } from './graph-scoped-materialization.js';
import type { SyncPageResult } from './page-fetch.js';

const DKG_NS = 'http://dkg.io/ontology/';

/** The metadata rows `parseConfirmedGraphKnowledgeAssetMetadataEnvelope` reads. */
const ENVELOPE_PREDICATES = [
  'contentScopeVersion', 'assertionVersion', 'publicTripleCount', 'privateTripleCount', 'batchId',
  'merkleRoot', 'privateMerkleRoot', 'assertionGraph', 'kaUal', 'status', 'transactionHash', 'subGraphName',
].map((name) => `${DKG_NS}${name}`);

/** Assets per store read: one VALUES list of exact metadata subjects. */
const HOLDINGS_READ_CHUNK = 200;

/** Assertion graphs per row-count query, so one query never holds the background lane long. */
const ROW_COUNT_CHUNK = 50;

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
  /**
   * Held copies the owner's run has confirmed current on chain, shared by its
   * rounds: a round whose checks ran out of budget leaves the next round only
   * the rest. A full-graph run likewise authenticates each asset once.
   */
  confirmedHeldCopies?: Set<string>;
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
 * confirmed graph-scoped copy at the descriptor's version, root, row counts,
 * graph and sub-graph, whose assertion graph still holds exactly the declared
 * number of public rows. Durable sync verified such a copy against its root
 * and the chain before it wrote the rows and the metadata in one atomic
 * replacement, but metadata alone is not proof: a removed sub-graph drops the
 * rows and keeps the envelope. One metadata query per chunk of assets, then
 * one row count per assertion graph, with no content re-hash. Whether the
 * copy is still the current version is for the caller to check.
 */
export async function readHeldGraphScopedAssets(
  store: TripleStore,
  request: HeldGraphScopedAssetsRequest,
  chunkSize = HOLDINGS_READ_CHUNK,
): Promise<Set<string>> {
  const metaGraph = assertSafeIri(contextGraphMetaUri(request.contextGraphId));
  const predicates = ENVELOPE_PREDICATES.map((predicate) => `<${predicate}>`).join(' ');
  const options = { priority: 'background' as const, signal: request.signal };
  const held = new Set<string>();
  for (let start = 0; start < request.descriptors.length; start += chunkSize) {
    const chunk = request.descriptors.slice(start, start + chunkSize);
    const subjects = chunk.map((descriptor) => `<${assertSafeIri(descriptor.ual)}>`).join(' ');
    // sparql-scan-allow: R4 -- exact meta graph; subjects and predicates are bound by finite VALUES lists
    const result = await store.query(
      `SELECT ?ual ?predicate ?object WHERE { GRAPH <${metaGraph}> { VALUES ?ual { ${subjects} } VALUES ?predicate { ${predicates} } ?ual ?predicate ?object } }`,
      { ...options, source: 'agent.durableSync.heldAssets' },
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
    const confirmed = chunk.filter((descriptor) => holdsDescriptor(
      descriptor,
      parseConfirmedGraphKnowledgeAssetMetadataEnvelope(
        rowsBySubject.get(descriptor.ual) ?? [],
        { contextGraphId: request.contextGraphId, ual: descriptor.ual },
      ),
    ));
    for (let rowStart = 0; rowStart < confirmed.length; rowStart += ROW_COUNT_CHUNK) {
      const counted = confirmed.slice(rowStart, rowStart + ROW_COUNT_CHUNK);
      // One indexed count per exact assertion graph, as the responder's page plan reads them.
      const counts = await store.query(`SELECT ?graph ?rows WHERE { ${counted.map(({ assertionGraph }) => {
        const graph = `<${assertSafeIri(assertionGraph)}>`;
        return `{ SELECT (${graph} AS ?graph) (COUNT(*) AS ?rows) WHERE { GRAPH ${graph} { ?s ?p ?o } } }`;
      }).join(' UNION ')} }`, { ...options, source: 'agent.durableSync.heldAssetRows' });
      if (counts.type !== 'bindings') throw new Error('Held asset row COUNT expected a bindings result');
      const rowsByGraph = new Map(counts.bindings.map(({ graph, rows }) => [graph, integerLexical(rows)]));
      for (const descriptor of counted) {
        if (rowsByGraph.get(descriptor.assertionGraph) === descriptor.publicTripleCount) held.add(descriptor.ual);
      }
    }
  }
  return held;
}

function integerLexical(raw: string | undefined): number | undefined {
  const lexical = raw?.replace(/^"([^"]*)"(?:\^\^.*)?$/, '$1');
  return lexical !== undefined && /^\d+$/.test(lexical) ? Number(lexical) : undefined;
}

/** The holdings reader a recovery host gives graph-owned rounds. */
export function heldGraphScopedAssetsReader(
  store: TripleStore,
): (request: HeldGraphScopedAssetsRequest) => Promise<Set<string>> {
  return (request) => readHeldGraphScopedAssets(store, request);
}

/** A peer's generation cannot be settled from holdings: its round fails, and the owner tries another peer. */
export class HeldGenerationNotCurrentError extends Error {
  readonly code = 'SYNC_HELD_GENERATION_NOT_CURRENT';
}

/** Held assets checked against the chain at once; the first mismatch stops the rest. */
const HELD_CHAIN_CHECK_CONCURRENCY = 8;

/**
 * Longest a round confirms held copies on chain, one recovery settlement slice.
 * On a slow or throttled endpoint, a round that runs out runs its DATA phase
 * instead of failing, and the run's next round checks only the copies left.
 */
export const HELD_CHAIN_CHECK_BUDGET_MS = 120_000;

/**
 * What a graph-owned round reads about holdings: which assets of a verified
 * generation the store holds, and whether those copies are current on chain.
 * The round asks the chain only when its plan relies on held copies.
 */
export interface DurableHoldingsReader {
  read(request: HeldGraphScopedAssetsRequest): Promise<ReadonlySet<string>>;
  /**
   * Resolve once every held copy is the asset's current version, as
   * authentication requires of a fetched copy: its chain root and root count
   * are the descriptor's, and the asset is bound to this context graph. A copy
   * the chain shows superseded or bound elsewhere rejects with
   * {@link HeldGenerationNotCurrentError}: this peer serves a superseded
   * generation, so the round fails and the owner tries another peer. A chain
   * that cannot answer for every held copy within one budget
   * ({@link HELD_CHAIN_CHECK_BUDGET_MS}, or the round's authentication deadline
   * if earlier) rejects with an ordinary error, and the round runs its DATA
   * rounds, which authenticate what they fetch. Copies in `confirmed` are not
   * checked again; each copy confirmed here is added to it.
   */
  confirmCurrent(
    request: HeldGraphScopedAssetsRequest,
    held: ReadonlySet<string>,
    confirmed?: Set<string>,
  ): Promise<void>;
}

const heldCopyKey = (descriptor: GraphScopedDescriptor) =>
  `${descriptor.ual}\0${descriptor.assertionVersion}\0${descriptor.claimedRootHex}`;

/** A store read and a chain read make a holdings reader; without either, rounds plan no shortcut. */
export function currentHeldGraphScopedAssetsReader(input: {
  readonly readHeld?: (request: HeldGraphScopedAssetsRequest) => Promise<ReadonlySet<string>>;
  readonly readChainState?: (copy: { readonly ual: string; readonly contextGraphId: string },
    deadline: number, signal?: AbortSignal) => Promise<GraphScopedAssetChainState>;
  /** The round's budget: the chain checks share one authentication deadline. */
  readonly budget: { createGraphScopedAuthenticationDeadline(): number };
}): DurableHoldingsReader | undefined {
  const { readHeld, readChainState } = input;
  if (!readHeld || !readChainState) return undefined;
  return {
    read: readHeld,
    confirmCurrent: async (request, held, confirmed) => {
      const deadline = Math.min(
        input.budget.createGraphScopedAuthenticationDeadline(),
        Date.now() + HELD_CHAIN_CHECK_BUDGET_MS,
      );
      const { contextGraphId } = request;
      await mapWithConcurrencyDrained(
        request.descriptors.filter((descriptor) => held.has(descriptor.ual)
          && !confirmed?.has(heldCopyKey(descriptor))),
        HELD_CHAIN_CHECK_CONCURRENCY,
        async (descriptor) => {
          const { ual, assertionVersion, claimedRootHex } = descriptor;
          let state: GraphScopedAssetChainState;
          try {
            state = await readChainState({ ual, contextGraphId }, deadline, request.signal);
          } catch (error) {
            request.signal?.throwIfAborted();
            throw new Error(
              `Could not check held asset ${ual} of "${contextGraphId}" against the chain within the round's budget: `
                + `${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
          if (!state.bound) {
            throw new HeldGenerationNotCurrentError(`Held asset ${ual} is not bound to "${contextGraphId}" on chain`);
          }
          if (state.assertionVersion !== BigInt(assertionVersion) || state.merkleRootHex !== claimedRootHex) {
            throw new HeldGenerationNotCurrentError(
              `This peer's generation of "${contextGraphId}" is behind the chain: ${ual} is at version `
                + `${state.assertionVersion} on chain, ${assertionVersion} here and at the peer`,
            );
          }
          confirmed?.add(heldCopyKey(descriptor));
        },
      );
    },
  };
}

function holdsDescriptor(
  descriptor: GraphScopedDescriptor,
  stored: ConfirmedGraphKnowledgeAssetMetadataRead,
): boolean {
  if (stored.state !== 'confirmed') return false;
  const { envelope } = stored;
  return BigInt(envelope.assertionVersion) === BigInt(descriptor.assertionVersion)
    && Buffer.from(envelope.merkleRoot).toString('hex') === descriptor.claimedRootHex
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
 * and leave a `fetch-missing` plan to the owner. A held copy the chain shows
 * superseded fails the round. A store or chain read that cannot answer plans
 * nothing: the round then runs its bounded full-graph rounds as before.
 */
export async function planDurableDataFromLocalHoldings(input: {
  readonly contextGraphId: string;
  readonly manifest: GraphScopedDurableManifestPlan;
  readonly channel: DurableHoldingsChannel;
  readonly holdings: DurableHoldingsReader;
  readonly signal?: AbortSignal;
  readonly logWarn: (message: string) => void;
}): Promise<DurableHoldingsPlan | undefined> {
  const { contextGraphId, manifest, channel, holdings } = input;
  const request = { contextGraphId, descriptors: manifest.descriptors, signal: input.signal };
  let plan: DurableHoldingsPlan;
  try {
    const held = await holdings.read(request);
    plan = planDurableDataFromHoldings(manifest, held, channel.ownerFetchesMissingAssets === true);
    // Full-graph rounds authenticate every asset they fetch: only a plan that skips held copies asks the chain.
    if (plan.kind !== 'full') await holdings.confirmCurrent(request, held, channel.confirmedHeldCopies);
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof HeldGenerationNotCurrentError) throw error;
    input.logWarn(
      `Could not establish which assets of "${contextGraphId}" this node holds; fetching the graph: `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
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
  recordDurableSyncDiagnostics(input.accumulator, {
    resumedPhases: 1,
    completedPhases: 1,
    // Readiness evidence for a completion that inserted nothing: every asset is stored and current.
    verifiedHeldAssets: manifest.descriptors.length,
  });
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
