// SPDX-License-Identifier: Apache-2.0

/**
 * Chain event subscription (listenForEvents).
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers } from 'ethers';
import type { EventFilter, ChainEvent } from './chain-adapter.js';
import { RPC_LOG_SCAN_TIMEOUT_MS } from './evm-adapter-constants.js';

// Wide `eth_getLogs` reads (over `[fromBlock ?? 0, toBlock]`, up to the poller's
// 9,000-block window / a cold-start full backfill) legitimately exceed the 4s
// point-read cap, so they fail over only after RPC_LOG_SCAN_TIMEOUT_MS on a
// multi-RPC node (single-RPC stays uncapped, #894). Without this a slow-but-
// healthy scan would abort, exhaust every endpoint, and stall the event poller.
const LOG_SCAN_OPTS = { multiAttemptTimeoutMs: RPC_LOG_SCAN_TIMEOUT_MS } as const;

export class EventsMethods extends EVMChainAdapterBase {
  // =====================================================================
  // Events
  // =====================================================================

  async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
    await this.init();

    for (const eventType of filter.eventTypes) {
      if (eventType === 'KnowledgeBatchCreated') {
        // V8-only event — emitted by archived KnowledgeAssetsStorage. When the
        // V8 contract is absent (the V10-only deploy path after this PR), this
        // branch yields nothing and consumers must rely on V10 `KCCreated`.
        const storage = this.contracts.knowledgeAssetsStorage;
        if (!storage) {
          continue;
        }
        const eventFilter = storage.filters.KnowledgeBatchCreated();
        const logs = await this.contractReadWithFailover(
          'kasV9.queryFilter(KnowledgeBatchCreated)', storage,
          (c) => c.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock),
          LOG_SCAN_OPTS,
        );

        for (const log of logs) {
          const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) {
            yield {
              type: 'KnowledgeBatchCreated',
              blockNumber: log.blockNumber,
              data: {
                batchId: parsed.args.batchId.toString(),
                publisherAddress: parsed.args.publisher?.toString(),
                merkleRoot: parsed.args.merkleRoot,
                startKAId: parsed.args.startKAId.toString(),
                endKAId: parsed.args.endKAId.toString(),
                txHash: log.transactionHash,
                // PR #845 (review #9): chain-truth tiebreaker — see KCCreated.
                txIndex: log.transactionIndex,
              },
            };
          }
        }
      }

      if (eventType === 'ContextGraphExpanded') {
        const cgStorage = this.contracts.contextGraphStorage;
        if (cgStorage) {
          const eventFilter = cgStorage.filters.ContextGraphExpanded();
          const logs = await this.contractReadWithFailover(
            'cgStorage.queryFilter(ContextGraphExpanded)', cgStorage,
            (c) => c.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock),
            LOG_SCAN_OPTS,
          );

          for (const log of logs) {
            const parsed = cgStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'ContextGraphExpanded',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.contextGraphId.toString(),
                  batchId: parsed.args.batchId?.toString(),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }

      // Phase B (chain-driven VM reconciliation): the canonical
      // "a KA was bound to a CG" signal. Both `contextGraphId` and `kaId`
      // are indexed, so the poller can subscribe with a topic filter on its
      // subscribed CG ids (no global firehose). Emitted by
      // `registerKnowledgeAssetToContextGraph` in the V10 publish flow.
      if (eventType === 'KnowledgeAssetRegisteredToContextGraph') {
        const cgStorage = this.contracts.contextGraphStorage;
        if (cgStorage) {
          const eventFilter = cgStorage.filters.KnowledgeAssetRegisteredToContextGraph();
          const logs = await this.contractReadWithFailover(
            'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)', cgStorage,
            (c) => c.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock),
            LOG_SCAN_OPTS,
          );

          for (const log of logs) {
            const parsed = cgStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'KnowledgeAssetRegisteredToContextGraph',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.contextGraphId.toString(),
                  kaId: parsed.args.kaId.toString(),
                  txHash: log.transactionHash,
                  txIndex: log.transactionIndex,
                },
              };
            }
          }
        }
      }

      // V10 greenfield (DKGKnowledgeAssets) emits `KnowledgeAssetCreated`
      // plus a single ERC-721 `Transfer(0x0, owner, tokenId)` per publish
      // (tokenId == kaId == kaId; no batch mint). Legacy V8/V9
      // (DKGKnowledgeAssets) emits `KnowledgeAssetCreated` +
      // `KnowledgeAssetsMinted` (a start/end range + recipient). The bound
      // contract may be either ABI (see resolveAssetStorage fallback in
      // init()), so resolve the create event the contract actually exposes
      // and derive the KA range / publisher from whichever mint surface is
      // present — otherwise a greenfield node would crash here calling a
      // non-existent `filters.KnowledgeAssetCreated()`.
      if (eventType === 'KCCreated' || eventType === 'KnowledgeAssetCreated') {
        const kaStorage = this.contracts.knowledgeAssetStorage;
        if (kaStorage) {
          const fromB = filter.fromBlock ?? 0;
          const toB = filter.toBlock ?? 'latest';

          const hasEvent = (name: string) =>
            kaStorage.interface.fragments.some(
              (f) => f.type === 'event' && (f as { name?: string }).name === name,
            );

          const isGreenfield = hasEvent('KnowledgeAssetCreated');
          const createEventName = isGreenfield
            ? 'KnowledgeAssetCreated'
            : 'KnowledgeAssetCreated';

          const kcFilter = kaStorage.filters[createEventName]();
          const kcLogs = await this.contractReadWithFailover(
            'kas.queryFilter(KnowledgeAssetCreated)', kaStorage, (c) => c.queryFilter(kcFilter, fromB, toB),
            LOG_SCAN_OPTS,
          );

          // Legacy mint range. `KnowledgeAssetsMinted` is still declared on the
          // greenfield ABI but never emitted by `createKnowledgeAsset`, so
          // this map stays empty there and the per-log fallback below derives
          // the (single-KA) range + owner from the create id + Transfer.
          const mintByTx = new Map<string, { publisherAddress: string; startKAId: string; endKAId: string }>();
          if (hasEvent('KnowledgeAssetsMinted')) {
            const mintFilter = kaStorage.filters.KnowledgeAssetsMinted();
            const mintLogs = await this.contractReadWithFailover(
              'kas.queryFilter(KnowledgeAssetsMinted)', kaStorage, (c) => c.queryFilter(mintFilter, fromB, toB),
              LOG_SCAN_OPTS,
            );
            for (const ml of mintLogs) {
              const mp = kaStorage.interface.parseLog({ topics: [...ml.topics], data: ml.data });
              if (mp) {
                mintByTx.set(ml.transactionHash, {
                  publisherAddress: mp.args.to,
                  startKAId: mp.args.startId.toString(),
                  endKAId: (BigInt(mp.args.endId) - 1n).toString(),
                });
              }
            }
          }

          // Greenfield publisher resolution: `_safeMint(author, kaId)` emits a
          // single ERC-721 mint `Transfer(address(0), owner, tokenId)`. The
          // token owner is the publisher/recipient of record (mirrors the
          // receipt-parse path). Keyed by tokenId so each KnowledgeAssetCreated
          // id resolves its own owner.
          const ownerByTokenId = new Map<string, string>();
          if (isGreenfield) {
            try {
              const transferFilter = kaStorage.filters.Transfer(ethers.ZeroAddress);
              const transferLogs = await this.contractReadWithFailover(
                'kas.queryFilter(Transfer)', kaStorage, (c) => c.queryFilter(transferFilter, fromB, toB),
                LOG_SCAN_OPTS,
              );
              for (const tl of transferLogs) {
                const tp = kaStorage.interface.parseLog({ topics: [...tl.topics], data: tl.data });
                if (tp && tp.args.tokenId != null) {
                  ownerByTokenId.set(tp.args.tokenId.toString(), String(tp.args.to));
                }
              }
            } catch {
              // Best-effort — the `author` topic on the create event is the
              // fallback when Transfer enumeration is unavailable.
            }
          }

          for (const log of kcLogs) {
            const parsed = kaStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              const mint = mintByTx.get(log.transactionHash);
              const idStr = parsed.args.id.toString();
              // V10.1: `author` is the EIP-712-attested author identity recovered
              // by `_verifyAuthorAttestation` on-chain (or `address(0)` for the
              // unattributed publish path). Surfacing it here lets replicas
              // rebuild `dkg:Publication` / `dkg:authoredBy` provenance triples
              // that match what the originating publisher emitted in
              // `generateKCMetadata` (Round 5 review §10).
              const author = typeof parsed.args.author === 'string' ? parsed.args.author : '';
              yield {
                type: 'KCCreated',
                blockNumber: log.blockNumber,
                data: {
                  kaId: idStr,
                  merkleRoot: parsed.args.merkleRoot,
                  merkleRootBytes: parsed.args.merkleRoot,
                  byteSize: parsed.args.byteSize.toString(),
                  txHash: log.transactionHash,
                  // PR #845 (review #9): chain-truth tiebreaker for the
                  // last-writer-wins materialization guard. The receiver's
                  // finalization handler must derive its version from the
                  // verified receipt, NOT a gossip-supplied `msg.txIndex`,
                  // because the latter is trust-based and can be inflated
                  // to lock out a legitimate same-block update.
                  txIndex: log.transactionIndex,
                  // Greenfield: no batch mint → publisher is the KA owner
                  // (Transfer recipient), falling back to the attested author.
                  publisherAddress: mint?.publisherAddress ?? ownerByTokenId.get(idStr) ?? author,
                  author,
                  // Greenfield: single KA, range collapses to [id, id].
                  startKAId: mint?.startKAId ?? idStr,
                  endKAId: mint?.endKAId ?? idStr,
                },
              };
            }
          }
        }
      }

      if (eventType === 'NameClaimed' || eventType === 'ContextGraphNameClaimed') {
        const registry = this.contracts.contextGraphNameRegistry;
        if (registry) {
          const eventFilter = registry.filters.NameClaimed();
          const logs = await this.contractReadWithFailover(
            'cgNameRegistry.queryFilter(NameClaimed)', registry,
            (c) => c.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock),
            LOG_SCAN_OPTS,
          );
          for (const log of logs) {
            const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'NameClaimed',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.nameHash?.toString() ?? '',
                  creator: parsed.args.creator?.toString() ?? '',
                  accessPolicy: Number(parsed.args.accessPolicy ?? 0),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }

      if (eventType === 'ContextGraphCreated') {
        const cgStorage = this.contracts.contextGraphStorage;
        if (cgStorage) {
          const eventFilter = cgStorage.filters.ContextGraphCreated();
          const logs = await this.contractReadWithFailover(
            'cgStorage.queryFilter(ContextGraphCreated)', cgStorage,
            (c) => c.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock),
            LOG_SCAN_OPTS,
          );
          for (const log of logs) {
            const parsed = cgStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              // OT-RFC-38 / LU-6 Phase B — `nameHash` is the curator-committed
              // wire id used to derive the SWM gossip topic. Zero indicates
              // the curator opted out at create time (rare); cores fall back
              // to the discovery-beacon path in that case.
              const nameHashRaw = parsed.args.nameHash?.toString() ?? '0x';
              const nameHash = nameHashRaw === '0x' ? null : nameHashRaw.toLowerCase();
              yield {
                type: 'ContextGraphCreated',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.contextGraphId?.toString() ?? '',
                  creator: parsed.args.owner?.toString() ?? '',
                  owner: parsed.args.owner?.toString() ?? '',
                  accessPolicy: Number(parsed.args.accessPolicy ?? 0),
                  publishPolicy: Number(parsed.args.publishPolicy ?? 0),
                  nameHash,
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }

      // RFC 04 v0.3 / Issue #461 — Network State Registry events.
      if (eventType === 'RelayCapabilityUpdated') {
        const profileStorage = this.contracts.profileStorage;
        if (profileStorage) {
          const eventFilter = profileStorage.filters.RelayCapabilityUpdated();
          const logs = await this.contractReadWithFailover(
            'profileStorage.queryFilter(RelayCapabilityUpdated)', profileStorage,
            (c) => c.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock),
            LOG_SCAN_OPTS,
          );
          for (const log of logs) {
            const parsed = profileStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'RelayCapabilityUpdated',
                blockNumber: log.blockNumber,
                data: {
                  identityId: parsed.args.identityId?.toString() ?? '0',
                  oldValue: Boolean(parsed.args.oldValue),
                  newValue: Boolean(parsed.args.newValue),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }
    }
  }
}
