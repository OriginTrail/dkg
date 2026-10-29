// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { ContextGraphSub } from './dkg-agent-types.js';
import { createAbortError as asSyncFetchAbortError } from './bounded-operation.js';
import { authenticateChallengePinnedGraphScopedAssetWithinDeadline } from './durable-recovery-authentication.js';
import { memoizeRecoveryBindingProof, type DurableRecoveryAuthority } from './durable-recovery-authority.js';
import { materializeVerifiedGraphScopedAsset, type GraphScopedMaterializationOutcome } from './sync/requester/graph-scoped-materialization.js';
import type { reconcileAfterMaterialization } from './sync/requester/post-materialization.js';
import { createGraphScopedPhysicalOperationFence } from './sync/requester/graph-scoped-operation-fence.js';
import { yieldStoreBackgroundLane } from './sync/requester/store-lane-yield.js';
import { contextGraphSubscriptionSyncPremisesEqual, isContextGraphSubscriptionStoredAgain } from './context-graph-subscription-policy.js';
import type { ChallengeExactAssetFetchContext, DurableSyncContext } from './sync/requester/durable-sync.js';

type MaterializationOptions = Parameters<typeof materializeVerifiedGraphScopedAsset>[0];
export interface RecoveryMaterializationPorts {
  chain(): ChainAdapter;
  store(): MaterializationOptions['store'];
  isClosed(): boolean;
  subscription(id: string): ContextGraphSub | undefined;
  bindingGeneration(id: string): number;
  isBindingGenerationCurrent(id: string, generation: number): boolean;
  track(run: Promise<unknown>): void;
  verifyBinding(id: string, onChainId: string, ctx: OperationContext, signal?: AbortSignal): Promise<boolean>;
  persistSubscription(id: string, subscription: ContextGraphSub, reason: 'on-chain id binding', isCurrent: () => boolean): Promise<void>;
  bindSubscription(id: string, subscription: ContextGraphSub, onChainId: string): void;
  logTiming(ctx: OperationContext, message: string): void;
  recordDrops: NonNullable<MaterializationOptions['oversizeHooks']>['recordDrops'];
  reconcile(asset: Parameters<typeof reconcileAfterMaterialization>[1], ctx: OperationContext): Promise<void>;
}
export interface RecoveryMaterializationScope {
  readonly ctx: OperationContext;
  readonly contextGraphId: string;
  readonly authority: DurableRecoveryAuthority;
  readonly isCurrent?: () => boolean;
  readonly onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
}
export interface HeldAssetFence {
  binding(): Readonly<{ onChainId?: string; generation: number }>;
  assertCurrent(): void;
}
export interface RecoveryMaterialization {
  withHeldAssetFence<T>(operation: (fence: HeldAssetFence) => Promise<T>, signal?: AbortSignal): Promise<T>;
  readonly authenticateChallengePinnedAsset: ChallengeExactAssetFetchContext['authenticateChallengePinnedAsset'];
  readonly storeGraphScopedAsset: NonNullable<DurableSyncContext['storeGraphScopedAsset']>;
}

/** Owns binding, authentication fences, physical draining and post-commit SWM cleanup.
 * Per-exchange proof/fence state is private; shared mutable agent state is accessed only through ports.
 */
export class RecoveryMaterializationOwner {
  constructor(private readonly ports: RecoveryMaterializationPorts) {}

  forOperation(scope: RecoveryMaterializationScope): RecoveryMaterialization {
    const { ports } = this;
    const { ctx, contextGraphId, authority, isCurrent, onAtomicCommitStarted } = scope;
    const assertLifecycleCurrent = () => {
      if (isCurrent?.() === false) {
        throw asSyncFetchAbortError(new Error(
          `Exact VM recovery lifecycle for ${contextGraphId} is no longer current`,
        ));
      }
    };
    const verifyContextGraphBinding = memoizeRecoveryBindingProof(
      (id, onChainId, signal) => ports.verifyBinding(id, onChainId, ctx, signal),
    );
    const runGraphScopedOperation = createGraphScopedPhysicalOperationFence({
      isClosed: () => ports.isClosed(),
      captureSubscription: (operationContextGraphId) =>
        ports.subscription(operationContextGraphId),
      captureBindingGeneration: (operationContextGraphId) =>
        ports.bindingGeneration(operationContextGraphId),
      isBindingGenerationCurrent: (operationContextGraphId, generation) =>
        ports.isBindingGenerationCurrent(
          operationContextGraphId,
          generation,
        ),
      // The same subscription (not one deleted and subscribed again, whose
      // binding generation starts over) and the same premises for a store.
      isEquivalentSubscription: (captured, current) =>
        isContextGraphSubscriptionStoredAgain(captured, current)
        && contextGraphSubscriptionSyncPremisesEqual(captured, current),
      assertLifecycleCurrent,
      asAbortError: asSyncFetchAbortError,
      track: (run) => ports.track(run),
    });
    let wroteAsset = false;
    return {
      withHeldAssetFence: (operation, signal) => runGraphScopedOperation({
        contextGraphId, signal,
        closedError: () => asSyncFetchAbortError(new Error('Held asset recovery is closed for node shutdown')),
        bindingChangedError: () => asSyncFetchAbortError(new Error(`Subscription for ${contextGraphId} changed during held recovery`)),
        operation: control => {
          const assertCurrent = () => { control.adoptEquivalentSubscription(); control.assertOwnershipCurrent(); };
          return operation({
            assertCurrent,
            binding: () => {
              assertCurrent();
              return { onChainId: control.subscription?.onChainId, generation: ports.bindingGeneration(contextGraphId) };
            },
          });
        },
      }),
      authenticateChallengePinnedAsset: ({
        asset,
        commitment,
        authenticationDeadline,
        signal: operationSignal,
      }) => runGraphScopedOperation({
        contextGraphId: asset.contextGraphId,
        signal: operationSignal,
        closedError: () => asSyncFetchAbortError(new Error(
          `Challenge-pinned authentication for ${asset.ual} is closed for node shutdown`,
        )),
        bindingChangedError: () => asSyncFetchAbortError(new Error(
          `Context graph binding for ${asset.contextGraphId} changed during challenge authentication`,
        )),
        operation: async ({ assertCurrent }) => {
          const authenticated =
            await authenticateChallengePinnedGraphScopedAssetWithinDeadline({
              chain: ports.chain(),
              asset,
              commitment,
              verifyContextGraphBinding,
              authenticationDeadline,
              signal: operationSignal,
            });
          assertCurrent();
          return authenticated;
        },
      }),
      storeGraphScopedAsset: ({
        asset,
        authenticationDeadline,
        signal: operationSignal,
      }) => runGraphScopedOperation({
        contextGraphId: asset.contextGraphId,
        signal: operationSignal,
        closedError: () => asSyncFetchAbortError(new Error(
          `Graph-scoped store for ${asset.ual} is closed for node shutdown`,
        )),
        bindingChangedError: () => asSyncFetchAbortError(new Error(
          `Context graph binding for ${asset.contextGraphId} changed during graph-scoped store`,
        )),
        operation: async (control): Promise<GraphScopedMaterializationOutcome> => {
          const storeCallStartedAt = Date.now();
          // This operation's asset writes run back to back: let queued store work in between them.
          if (wroteAsset) {
            await yieldStoreBackgroundLane({ signal: operationSignal });
          }
          const { isBindingCurrent, recaptureBindingGeneration, assertCurrent } = control;
          const authenticationStartedAt = Date.now();
          const authentication = await authority.authenticate(asset, authenticationDeadline, operationSignal);
          const authenticationFinishedAt = Date.now();
          control.adoptEquivalentSubscription();
          assertCurrent();
          const subscription = control.subscription;
          const verifiedOnChainId = authentication.onChainContextGraphId;
          if (
            verifiedOnChainId
            && subscription?.onChainId
            && subscription.onChainId !== verifiedOnChainId
          ) {
            throw Object.assign(
              new Error(
                `Graph-scoped durable sync ${asset.ual} belongs to on-chain context graph `
                + `${verifiedOnChainId}, but local ${asset.contextGraphId} is already bound to `
                + `${subscription.onChainId}`,
              ),
              { code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' },
            );
          }
          if (verifiedOnChainId && subscription && subscription.onChainId === undefined) {
            // An on-demand subscription binds in memory only; durable rows are
            // saved before the binding becomes visible.
            await ports.persistSubscription(
              asset.contextGraphId,
              { ...subscription, onChainId: verifiedOnChainId, lastReconciledOrdinal: 0 },
              'on-chain id binding',
              isBindingCurrent,
            );
            assertCurrent();
            ports.bindSubscription(
              asset.contextGraphId,
              subscription,
              verifiedOnChainId,
            );
            recaptureBindingGeneration();
            assertCurrent();
          }
          assertCurrent();
          const writeStartedAt = Date.now();
          onAtomicCommitStarted?.(asset.contextGraphId, asset.ual);
          assertCurrent();
          const outcome = await materializeVerifiedGraphScopedAsset({
            store: ports.store(),
            asset: authentication.asset,
            isCurrent: () => (isCurrent?.() ?? true) && isBindingCurrent(),
            shouldQuarantineCommitted: () => {
              const current = ports.subscription(asset.contextGraphId);
              return (subscription !== undefined && current === undefined)
                || (verifiedOnChainId !== null
                  && current !== undefined
                  && current.onChainId !== verifiedOnChainId);
            },
            options: {
              priority: 'background',
              source: 'agent.durableSync.graphScopedMaterialization',
              signal: operationSignal,
            },
            oversizeHooks: {
              recordDrops: (drops, seam) => ports.recordDrops(drops, seam),
            },
          });
          const storeFinishedAt = Date.now();
          if (outcome === 'applied') await ports.reconcile(authentication.asset, ctx);
          ports.logTiming(ctx, `Recovery store timing: laneWait=${authenticationStartedAt - storeCallStartedAt}ms `
            + `authentication=${authenticationFinishedAt - authenticationStartedAt}ms `
            + `binding=${writeStartedAt - authenticationFinishedAt}ms store=${storeFinishedAt - writeStartedAt}ms `
            + `reconcile=${Date.now() - storeFinishedAt}ms outcome=${outcome}`);
          wroteAsset = true;
          return outcome;
        },
      }),
    };
  }
}
