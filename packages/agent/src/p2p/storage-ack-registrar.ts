import { ethers } from 'ethers';
import {
  contextGraphSharedMemoryUri, createOperationContext,
  isKaPublishLifecycleDebugLoggingEnabled, isStorageACKDecline,
  type Logger, type OperationContext,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  StorageACKHandler, createStorageAckLifecycleObserver, withSignerRegistrationCache,
} from '@origintrail-official/dkg-publisher';
import { DKGAgentBase } from '../dkg-agent-base.js';
import type { DKGAgent } from '../dkg-agent.js';
import type { ResolvedDKGAgentConfig } from '../dkg-agent-types.js';
import { BOOT_CHAIN_IDENTITY_TIMEOUT_MS, MIN_STORAGE_ACK_REGISTRATION_RETRY_MS,
  STORAGE_ACK_REGISTRATION_RETRY_MS } from '../dkg-agent-constants.js';
import { isTransientBootChainError, raceWithBootTimeout } from '../dkg-agent-boot.js';
import { resolveStorageAckLifecycleAssetUalFromLocalSwm } from '../storage-ack-lifecycle-identity.js';
import { type SyncBackpressureSnapshot } from '../sync/backpressure.js';
import { registerStorageACKEndpoint } from './storage-ack-endpoint.js';
import {
  mayReresolveACKIdentity, shouldRepairACKWallets,
  type StorageACKRegistrationAttempt, type StorageACKRegistrationAttemptContext,
  type RegistrationOutcome, type StorageACKRegistrationPlan,
} from './storage-ack-registration-runtime.js';

/** Startup supplies the mutable identity result and capabilities; this registrar owns ACK registration policy. */
export interface StorageACKRegistrarPorts {
  store: DKGAgent['store'];
  publisher: DKGAgent['publisher'];
  eventBus: DKGAgent['eventBus'];
  messenger: DKGAgent['messenger'];
  localPeerId(): string;
  provisionProfileGuarded: OmitThisParameter<DKGAgent['provisionProfileGuarded']>;
  resolveConfirmedACKSigner: OmitThisParameter<DKGAgent['resolveConfirmedACKSigner']>;
  canonicalChunkStoreCgIdOrNull: OmitThisParameter<DKGAgent['canonicalChunkStoreCgIdOrNull']>;
  resolveCgCurationForAck(cgId: string): ReturnType<DKGAgent['resolveCgCurationForAck']>;
  ensureStorageAckVmPromotion: OmitThisParameter<DKGAgent['ensureStorageAckVmPromotion']>;
  promoteStorageAckPriorVersion: OmitThisParameter<DKGAgent['promoteStorageAckPriorVersion']>;
  readStorageAckKnowledgeAssetRootCount: OmitThisParameter<DKGAgent['readStorageAckKnowledgeAssetRootCount']>;
  recordStorageAckDecline: OmitThisParameter<DKGAgent['recordStorageAckDecline']>;
  gossipWireIdFor: OmitThisParameter<DKGAgent['gossipWireIdFor']>;
  getSwmSubscriptionSource: OmitThisParameter<DKGAgent['getSwmSubscriptionSource']>;
  prepareDurableRootAtomicCompanion: NonNullable<ConstructorParameters<typeof StorageACKHandler>[1]['resolveDurableRootAtomicCompanion']>;
  chain: ChainAdapter;
  config: ResolvedDKGAgentConfig;
  log: Logger;
  writeLocks: Map<string, Promise<void>>;
  bootCtx: OperationContext;
  signerCandidates: ethers.Wallet[];
  initialIdentityId: bigint;
  transientIdentityUnresolved: boolean;
  isRegistered(): boolean;
  isStarted(): boolean;
  ensureWalletsRegistered(ctx: OperationContext, identityId: bigint): Promise<boolean>;
  syncPressureSnapshot(): SyncBackpressureSnapshot;
}

export function createStorageACKRegistrationPlan(ports: StorageACKRegistrarPorts): StorageACKRegistrationPlan {
  let onChainIdentityId = ports.initialIdentityId;
  let bootChainIdentityUnresolvedTransient = ports.transientIdentityUnresolved;
  const attemptStorageACKRegistration = async (
    attemptCtx: OperationContext,
    attempt: StorageACKRegistrationAttempt,
    registration: StorageACKRegistrationAttemptContext,
  ): Promise<RegistrationOutcome> => {
    if (!registration.isActive()) return { kind: 'disabled' };
    if (ports.isRegistered()) return { kind: 'disabled' };
    // #894 / Codex PR #901 (round 2): background identity re-resolution.
    // If boot left the identity unresolved because of a transient chain
    // failure (RPC timeout/unreachable), re-probe the chain — but ONLY on
    // the scheduled retry path (`allowChainReresolution`), never on the
    // first attempt awaited by `start()`. The boot path already spent its
    // chain-timeout budget resolving identity; doing another bounded
    // chain probe here would stack a third ~20s wait onto `start()` and
    // blow the 45s readiness ceiling this fix exists to protect (Codex
    // :1752). On the first attempt we return 'retryable' immediately and
    // let the unref'd retry timer do the (background) re-resolution.
    //
    // We do NOT re-probe on a settled 0n (the flag stays false), so an
    // intentional no-identity node doesn't spin the chain pointlessly.
    if (
      onChainIdentityId === 0n
      && bootChainIdentityUnresolvedTransient
      && mayReresolveACKIdentity(attempt)
    ) {
      try {
        let reresolved = await registration.guard(() => raceWithBootTimeout(
          ports.chain.getIdentityId(),
          BOOT_CHAIN_IDENTITY_TIMEOUT_MS,
          'StorageACK identity re-resolution',
        ));
        // Codex :1757: a brand-new core node may have hit the transient
        // failure BEFORE `ensureProfile()` ever ran, so it has no profile
        // to find. Re-probing `getIdentityId()` alone would return 0n
        // forever and the node would never provision. Once the chain is
        // reachable again, create the profile (core only) — mirroring the
        // boot-time provisioning path. Codex round-3 :1685: provision via
        // the guarded, un-raced helper so the mutating createProfile+stake
        // tx runs to completion and is never double-submitted alongside a
        // boot-path (or concurrent-retry) provisioning still in flight.
        if (reresolved === 0n) {
          ports.log.info(attemptCtx, `No on-chain identity after transient boot outage — creating profile and staking...`);
          reresolved = await registration.guard(() => ports.provisionProfileGuarded(attemptCtx));
        }
        if (reresolved > 0n) {
          onChainIdentityId = reresolved;
          bootChainIdentityUnresolvedTransient = false;
          ports.publisher.setIdentityId(onChainIdentityId);
          ports.log.info(
            attemptCtx,
            `Recovered on-chain identity=${onChainIdentityId} for StorageACK after a transient boot-time chain failure`,
          );
        }
      } catch (err) {
        if (!registration.isActive()) return { kind: 'disabled' };
        // Codex PR #901 round-4 :1838: mirror the boot-path :1714 gate on
        // the retry path. If the chain came back but provisioning then
        // failed DETERMINISTICALLY (insufficient funds / revert / admin),
        // keeping the transient flag set would re-run `ensureProfile()`
        // every interval forever. Reclassify: permanent → clear the flag
        // so the terminal branch below returns 'disabled' (surface once,
        // stop scheduling); transient → keep retrying.
        if (!isTransientBootChainError(err)) {
          bootChainIdentityUnresolvedTransient = false;
          ports.log.warn(
            attemptCtx,
            `V10 StorageACK identity provisioning failed permanently — disabling (no further retries): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          ports.log.warn(
            attemptCtx,
            `StorageACK identity re-resolution failed (chain still unreachable?), will retry: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (onChainIdentityId > 0n) {
      const registrationSucceeded = !shouldRepairACKWallets(attempt)
        ? true
        : await registration.guard(() => ports.ensureWalletsRegistered(attemptCtx, onChainIdentityId));
      const signerResolution = await registration.guard(() => ports.resolveConfirmedACKSigner(
        onChainIdentityId,
        ports.signerCandidates,
        attemptCtx,
      ));
      const ackSignerWallet = signerResolution.wallet;
      if (!ackSignerWallet) {
        return { kind: (registrationSucceeded && !signerResolution.retryable) ? 'disabled' : 'retryable' };
      }

      // The V10 ACK digest includes a (chainid, kav10Address) H5 prefix
      // per KnowledgeAssetsV10.sol:362-373. Resolve both from the chain
      // adapter BEFORE constructing the handler so the handler can sign
      // digests that actually verify on-chain. The handler itself has
      // no provider-backed dependency, so both values are passed in at
      // construction.
      const chainIdForHandler = typeof ports.chain.getEvmChainId === 'function'
        ? await registration.guard(() => ports.chain.getEvmChainId!())
        : undefined;
      const kav10AddressForHandler = typeof ports.chain.getKnowledgeAssetsLifecycleAddress === 'function'
        ? await registration.guard(() => ports.chain.getKnowledgeAssetsLifecycleAddress!())
        : undefined;
      if (chainIdForHandler === undefined || kav10AddressForHandler === undefined) {
        ports.log.warn(
          attemptCtx,
          `Skipping V10 StorageACK handler: chain adapter does not expose ` +
          `getEvmChainId() + getKnowledgeAssetsLifecycleAddress(); handler cannot build the ` +
          `H5-prefixed ACK digest that KnowledgeAssetsV10 verifies on-chain`,
        );
        return { kind: 'disabled' };
      }

      const ackHandler = new StorageACKHandler(ports.store, {
        nodeRole: 'core',
        nodeIdentityId: onChainIdentityId,
        signerWallet: ackSignerWallet,
        contextGraphSharedMemoryUri,
        chainId: chainIdForHandler,
        kav10Address: kav10AddressForHandler,
        workspaceWriteLocks: ports.writeLocks,
        resolveDurableRootAtomicCompanion: (input) => {
          if (ports.config.dataDir === undefined) return;
          return ports.prepareDurableRootAtomicCompanion(input);
        },
        ackHandlerDeadlineMs: ports.config.storageAckTiming.handlerDeadlineMs,
        // Codex review (round 2) on PR #727: must NOT collapse to a
        // plain `gossipWireIdFor` because `PublishIntent.swmGraphId`
        // may be absent on a chunked V2 intent (the handler then
        // falls back to the numeric `cgId`). Pass through
        // `canonicalChunkStoreCgIdOrNull` so numeric ids resolve via
        // the local on-chain map, and unknown shapes return null →
        // handler widens to wildcard `GRAPH ?g` instead of pinning
        // to a fabricated keccak-of-decimal-string.
        normalizeContextGraphIdForChunkStore: (rawCgId: string) =>
          ports.canonicalChunkStoreCgIdOrNull(rawCgId),
        isCgCurated: (cgId: string) => ports.resolveCgCurationForAck(cgId),
        // StorageACK finality gate: a public ACK is signed only after
        // this core durably commits to promote the KA into its VM.
        ensureVmPromotion: (request) => ports.ensureStorageAckVmPromotion(request),
        // An update ACK waiting on the version it replaces: promote
        // that version now so the publisher's retry is signed.
        onPriorVersionAwaitingPromotion: (request) => ports.promoteStorageAckPriorVersion(request),
        readKnowledgeAssetRootCount: (kaUal, signal) =>
          ports.readStorageAckKnowledgeAssetRootCount(kaUal, signal),
        pendingAckTxWindowMs: DKGAgentBase.STORAGE_ACK_PENDING_TX_WINDOW_MS,
        // Testnet dead-air fix: `isOperationalWalletRegistered` is a
        // LIVE chain read the handler runs on EVERY inbound StorageACK.
        // With the raw wiring, one degraded shared RPC made the lookup
        // throw on every ACK on every core simultaneously — the whole
        // network stopped ACKing at once (the 21-attempts-all-
        // no_response incident). The cache wrapper serves the last
        // good verdict for 30s (no RPC per ACK in steady state) and
        // keeps serving it up to 5 min through an RPC outage;
        // registration changes are operator-driven and rare, so that
        // staleness window is safe. Both verdicts are cached — a
        // known-unregistered signer shouldn't hammer the RPC either.
        // The closure state lives (and dies) with this handler
        // registration attempt, so a signer failover / re-register
        // always starts from a fresh cache.
        isSignerRegistered: withSignerRegistrationCache(
          async () => {
            const isOperationalWalletRegistered = ports.chain.isOperationalWalletRegistered;
            if (typeof isOperationalWalletRegistered !== 'function') return false;
            return isOperationalWalletRegistered.call(
              ports.chain,
              onChainIdentityId,
              ackSignerWallet.address,
            );
          },
          {
            onServedStale: (err, staleValue) => {
              ports.log.debug?.(
                attemptCtx,
                `V10 StorageACK signer registration lookup failed; serving cached ` +
                `verdict=${staleValue} for ${ackSignerWallet.address}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              );
            },
          },
        ),
        onSignerUnregistered: () => {
          if (!registration.signerLost()) return;
          ports.log.warn(
            attemptCtx,
            `Unregistered V10 StorageACK handler: signer ${ackSignerWallet.address} ` +
            `is no longer confirmed on-chain for identity=${onChainIdentityId}`,
          );
        },
        onSignerRegistrationLookupFailed: (err) => {
          ports.log.warn(
            attemptCtx,
            `V10 StorageACK signer registration lookup failed for ${ackSignerWallet.address}; ` +
            `keeping handler active: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
        onDecline: (details) => {
          ports.recordStorageAckDecline(details.code);
          const syncPressure = ports.syncPressureSnapshot();
          const syncPressureLabel =
            `syncGlobalInflight=${syncPressure.inflight} ` +
            `syncGlobalQueued=${syncPressure.queued} ` +
            `syncGlobalLimit=${syncPressure.limit ?? 'unbounded'} ` +
            `syncGlobalQueueLimit=${syncPressure.queueLimit ?? 'unbounded'} ` +
            `syncQueuedElevated=${syncPressure.queuedByPriorityClass.elevated} ` +
            `syncQueuedDefault=${syncPressure.queuedByPriorityClass.default} ` +
            `syncQueuedDeprioritized=${syncPressure.queuedByPriorityClass.deprioritized} ` +
            `syncOldestQueuedAgeMs=${syncPressure.oldestQueuedAgeMs}`;
          ports.log.warn(
            attemptCtx,
            `V10 StorageACK declined: code=${details.code} ` +
            `cg=${details.contextGraphId} reason=${details.message} ${syncPressureLabel}`,
          );
        },
        onStorageAckDecision: createStorageAckLifecycleObserver({
          logger: ports.log,
          localPeerId: () => ports.localPeerId(),
          localNodeIdentityId: () => onChainIdentityId,
          shouldObserve: (decision) =>
            isKaPublishLifecycleDebugLoggingEnabled() || isStorageACKDecline(decision.ack),
          detailForDecision: (decision) =>
            isStorageACKDecline(decision.ack) ? 'summary' : 'debug',
          resolveAssetUalForPublishIntent: ({ intent }) =>
            resolveStorageAckLifecycleAssetUalFromLocalSwm({
              store: ports.store,
              chain: ports.chain,
              intent,
            }),
        }),
        // PR5 ACK-provenance — bind to the agent's host-mode
        // bookkeeping so every signed ACK carries which of the
        // four LU-6 Phase B discovery paths brought this CG's
        // hosting state up. Resolver tries each candidate id
        // because the two consulted maps are keyed differently:
        // `sharedMemoryGossipRegistered` (member-mode) uses the
        // CALLER-supplied cleartext id verbatim, while
        // `swmHostModeSubscribed` (host-mode) is canonical-keyed
        // by the wire-form hash (see `getSwmSubscriptionSource`
        // and `canonicalSwmHostModeKey`).
        //
        // PR5 (review fix #1) + PR-B Codex #672 review
        // `id=3302086589`: `getSwmSubscriptionSource` now
        // canonicalises each candidate internally before the
        // host-mode lookup, so on the host-only paths a single
        // pass through any of the four shapes (numeric / cleartext
        // / pre-canonical / hash) lands. We still hand it both
        // the cleartext and the pre-computed wire forms so the
        // MEMBER-mode `has(id)` check (which keys by cleartext)
        // gets the cleartext candidate without the canonicaliser
        // having to round-trip it. Variadic + internal `seen` Set
        // dedups, so over-passing is cheap and order-independent.
        getSubscriptionSourceForCg: (cgId, swmGraphId) => {
          // Phase D core-hosted recording is no longer started here: the
          // `ensureVmPromotion` finality gate records it durably BEFORE
          // a public ACK is signed.
          const wireFromCgId = cgId ? ports.gossipWireIdFor(cgId) : undefined;
          const wireFromSwmGraphId = swmGraphId && swmGraphId !== cgId
            ? ports.gossipWireIdFor(swmGraphId)
            : undefined;
          return ports.getSwmSubscriptionSource(
            cgId,
            swmGraphId,
            wireFromCgId,
            wireFromSwmGraphId,
          );
        },
      }, ports.eventBus);
      // rc.9 PR-11: migrated onto the Universal Messenger
      // substrate (wire prefix /dkg/10.0.1/storage-ack).
      // messenger.register handles envelope decode + receiver
      // dedup; ackHandler's signature stays the same.
      const endpoint = registerStorageACKEndpoint({
        registerGroup: (entries) => ports.messenger.registerGroup(entries),
        publish: (data, peerIdStr) => {
          const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
          return ackHandler.handler(data, peerId);
        },
        update: (data, peerIdStr) => {
          const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
          return ackHandler.updateHandler(data, peerId);
        },
        publishLocal: (data, peerIdStr, signal, context) => {
          const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
          return ackHandler.localExecution(data, peerId, signal, context);
        },
        updateLocal: (data, peerIdStr, signal, context) => {
          const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
          return ackHandler.localUpdateExecution(data, peerId, signal, context);
        },
      });
      ports.log.info(
        attemptCtx,
        `Registered V10 StorageACK handler (identity=${onChainIdentityId}, signer=${ackSignerWallet.address})`,
      );
      return { kind: 'registered', endpoint };
    } else if (bootChainIdentityUnresolvedTransient) {
      // #894 / Codex PR #901: identity is still 0n only because the
      // chain was unreachable at boot and the re-resolution above hasn't
      // recovered it yet. This is recoverable, so report 'retryable' —
      // the scheduled retry keeps re-probing and registers ACK once the
      // RPC returns, instead of leaving a core node permanently
      // un-advertised until restart.
      ports.log.warn(attemptCtx, `Deferring V10 StorageACK handler registration — on-chain identity not yet resolved (transient chain outage at boot); will retry`);
      return { kind: 'retryable' };
    } else {
      ports.log.warn(attemptCtx, `Skipping V10 StorageACK handler registration — identity not yet provisioned`);
      return { kind: 'disabled' };
    }
  };


  // Clamp the retry delay so bad config cannot hammer an unhealthy RPC.
  const requestedRetryMs = ports.config.storageAckRegistrationRetryMs;
  const storageACKRegistrationRetryMs =
    typeof requestedRetryMs === 'number' && Number.isFinite(requestedRetryMs)
      ? Math.max(requestedRetryMs, MIN_STORAGE_ACK_REGISTRATION_RETRY_MS)
      : STORAGE_ACK_REGISTRATION_RETRY_MS;
  return {
    attempt: (attempt, registration) => attemptStorageACKRegistration(
      attempt.kind === 'initial' ? ports.bootCtx : createOperationContext('connect'), attempt, registration,
    ),
    retryDelayMs: storageACKRegistrationRetryMs,
    isStarted: ports.isStarted,
    onRetryScheduled: () => ports.log.warn(ports.bootCtx, `V10 StorageACK handler registration will retry every ${storageACKRegistrationRetryMs}ms`),
    onError: (phase, err) => {
      const label = phase === 'initial' ? 'Skipping V10 StorageACK handler'
        : phase === 'failover' ? 'V10 StorageACK signer failover failed'
          : 'V10 StorageACK handler registration retry failed';
      ports.log.warn(ports.bootCtx, `${label}: ${err instanceof Error ? err.message : String(err)}`);
    },
  };
}
