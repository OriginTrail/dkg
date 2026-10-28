import { persistDurableManifestBoundary } from './durable-manifest-checkpoint.js';
// SPDX-License-Identifier: Apache-2.0
import type { HeldGraphScopedAssetsRequest } from './stored-graph-assets.js';
export { readHeldGraphScopedAssets, heldGraphScopedAssetsReader, type HeldGraphScopedAssetsRequest } from './stored-graph-assets.js';
import { getSyncCheckpointKey } from '../checkpoint/state.js';
import {
  type GraphScopedDurableManifestPlan,
  type GraphScopedDescriptor,
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
import type { AuthenticateHeldAsset, HeldAssetMembership } from './held-assets-contracts.js';
import type { GraphScopedChainEvidence } from './graph-scoped-chain-views.js';

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
export interface DurableHoldingsOptions {
  /** Set by the owner when it fetches missing assets itself. */
  readonly ownerFetchesMissingAssets?: boolean;

}

export type DurableDataStrategy<HeldEvidence = unknown, FullEvidence = unknown> =
  | ({ readonly kind: 'held'; readonly assets: number } & HeldEvidence)
  | ({
      readonly kind: 'fetch-missing';
      readonly held: number;
      readonly batches: readonly (readonly MissingDurableAsset[])[];
      readonly rows: number;
    } & HeldEvidence)
  | ({ readonly kind: 'full'; readonly held: number } & FullEvidence);

/** A peer's generation cannot be settled from holdings: its round fails, and the owner tries another peer. */
export class HeldGenerationNotCurrentError extends Error {
  readonly code = 'SYNC_HELD_GENERATION_NOT_CURRENT';
}

/** Held assets checked against the chain at once; the first mismatch stops the rest. */
const HELD_CHAIN_CHECK_CONCURRENCY = 8;

/**
 * Longest a round confirms held copies on chain, one recovery settlement slice.
 * On a slow or throttled endpoint, a round that runs out runs its DATA phase
 * instead of failing. Intermediate missing-asset plans may reuse successful
 * checks, but terminal held completion must check every copy afresh.
 */
export const HELD_CHAIN_CHECK_BUDGET_MS = 120_000;

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
 * rounds, which authenticate what they fetch. Prior confirmations may only
 * guide intermediate missing-asset work: they do not prove currentness at a
 * later terminal boundary without fresh chain revision evidence.
 */
export type ConfirmHeldAssetsCurrent = (
  request: HeldGraphScopedAssetsRequest,
  held: HeldAssetMembership,
  options?: { readonly reuseIntermediateConfirmations?: boolean },
) => Promise<void>;

const heldCopyKey = (descriptor: GraphScopedDescriptor) =>
  `${descriptor.ual}\0${descriptor.assertionVersion}\0${descriptor.claimedRootHex}`;

/** Chain confirmation for content already owned by an acquired store proof. */
interface HeldAssetsConfirmationInput {
  readonly binding?: () => Readonly<{ onChainId?: string; generation: number }>;
  readonly authenticateHeld?: AuthenticateHeldAsset;
  /** The round's budget: the chain checks share one authentication deadline. */
  readonly budget: { createGraphScopedAuthenticationDeadline(): number };
}
/** Prior chain verdicts guide intermediate work, never terminal held readiness. */
export class HeldAssetsConfirmationRun {
  private readonly confirmed = new Set<string>();
  forRound(input: HeldAssetsConfirmationInput): ConfirmHeldAssetsCurrent | undefined {
    return bindHeldAssetsConfirmer(input, this.confirmed);
  }
}
export function currentHeldGraphScopedAssetsConfirmer(input: HeldAssetsConfirmationInput): ConfirmHeldAssetsCurrent | undefined {
  return new HeldAssetsConfirmationRun().forRound(input);
}
function bindHeldAssetsConfirmer(input: HeldAssetsConfirmationInput, confirmed: Set<string>): ConfirmHeldAssetsCurrent | undefined {
  const { authenticateHeld } = input;
  if (!authenticateHeld) return undefined;
  return async (request, held, options) => {
    const deadline = Math.min(
      input.budget.createGraphScopedAuthenticationDeadline(),
      Date.now() + HELD_CHAIN_CHECK_BUDGET_MS,
    );
    const { contextGraphId } = request;
    const binding = input.binding?.();
    const bindingKey = (value: typeof binding) => `${contextGraphId}\0${value?.generation ?? ''}\0${value?.onChainId ?? ''}`;
    const capturedBinding = bindingKey(binding);
    const cacheKey = (descriptor: GraphScopedDescriptor) => `${capturedBinding}\0${heldCopyKey(descriptor)}`;
    await mapWithConcurrencyDrained(
      request.descriptors.filter((descriptor) => held.has(descriptor.ual)
        && !(options?.reuseIntermediateConfirmations && confirmed.has(cacheKey(descriptor)))),
      HELD_CHAIN_CHECK_CONCURRENCY,
      async (descriptor) => {
        const { ual } = descriptor;
        let current: GraphScopedChainEvidence;
        try {
          current = await authenticateHeld(descriptor, binding?.onChainId, deadline, request.signal);
        } catch (error) {
          request.signal?.throwIfAborted();
          throw new Error(
            `Could not check held asset ${ual} of "${contextGraphId}" against the chain within the round's budget: `
              + `${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        request.signal?.throwIfAborted();
        if (current.kind === 'mismatch') throw new HeldGenerationNotCurrentError(`Held asset ${ual} of "${contextGraphId}" is not current on chain: ${current.message}`);
        confirmed.add(cacheKey(descriptor));
      },
    );
    if (input.binding && bindingKey(input.binding()) !== capturedBinding) {
      throw new HeldGenerationNotCurrentError(`Local binding for "${contextGraphId}" changed during held-copy checks`);
    }
  };
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
  held: HeldAssetMembership,
  ownerFetchesMissingAssets: boolean,
  budget: DurableDataRoundBudget = DEFAULT_DURABLE_DATA_ROUND_BUDGET,
): DurableDataStrategy {
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
  persistDurableManifestBoundary({
    checkpointKey: getSyncCheckpointKey(input.remotePeerId, input.contextGraphId, false, 'data'),
    manifest, offset: manifest.manifestRowCount, terminal: true, session: { kind: 'discard' },
    deleteCheckpoint: input.deleteCheckpoint, setCheckpoint: input.setCheckpoint,
  });
  recordDurableSyncDiagnostics(input.accumulator, {
    resumedPhases: 1,
    completedPhases: 1,
    // Readiness evidence for a completion that inserted nothing: every asset is stored and current.
    verifiedHeldAssets: manifest.descriptors.length,
  });
}

/**
 * Settle the DATA decision after the shared page scope persisted and counted META.
 * Settle a held generation with {@link settleHeldDurableData},
 * which makes the round complete. A fetch-missing round stays incomplete; the
 * owner fetches what it left. Returns the round's log line.
 */
export function settleDurableDataFromHoldings(input: Parameters<typeof settleHeldDurableData>[0] & {
  readonly plan: Exclude<DurableDataStrategy, { kind: 'full' }>;
}): string {
  const { plan, accumulator } = input;
  if (plan.kind === 'held') settleHeldDurableData(input);
  markDurableTerminalBoundary(accumulator, plan.kind === 'held');
  return describeDurableHoldingsPlan(input.contextGraphId, input.manifest, plan);
}

export function describeDurableHoldingsPlan(
  contextGraphId: string,
  manifest: GraphScopedDurableManifestPlan,
  plan: Exclude<DurableDataStrategy, { kind: 'full' }>,
): string {
  return plan.kind === 'held'
    ? `Durable data for "${contextGraphId}" is already held at this META generation `
      + `(${plan.assets} assets, ${manifest.manifestRowCount} rows): skipping the DATA phase`
    : `Durable data for "${contextGraphId}": ${plan.held} of ${manifest.descriptors.length} assets already held; `
      + `leaving ${manifest.descriptors.length - plan.held} asset(s) (${plan.rows} rows) `
      + `to ${plan.batches.length} exact request(s)`;
}
