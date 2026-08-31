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

/**
 * Every `DKGKnowledgeAssets` event that mutates a Knowledge Asset's committed
 * Merkle-root set, as ONE join constant.
 *
 * A KA's root changes through four distinct emitters (`updateKnowledgeAsset`,
 * `pushMerkleRoot`, `setMerkleRoots`, `popMerkleRoot`); subscribing to a subset
 * silently loses the rest, and the loss is invisible because a poller lane that
 * asks for a name the adapter never yields simply scans and finds nothing. The
 * lane declares its `eventTypes()` as exactly this constant and a test asserts
 * that equality, so adding a fifth emitter is a one-line change here rather
 * than a hunt through the publisher.
 *
 * NOTE: this is the on-chain EVENT-NAME vocabulary. The off-chain
 * classification these map to is core's `KnowledgeAssetRootMutationKindV1`.
 */
export const KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES = [
  'KnowledgeAssetUpdated',
  'KnowledgeAssetMerkleRootAdded',
  'KnowledgeAssetMerkleRootsUpdated',
  'KnowledgeAssetMerkleRootRemoved',
] as const;

export type KnowledgeAssetRootMutationEventType =
  (typeof KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES)[number];

export class EventsMethods extends EVMChainAdapterBase {
  // =====================================================================
  // Events
  // =====================================================================

  /**
   * A WIDE `eth_getLogs` scan with read-failover, baking in the `wideLogScan`
   * policy so the wide-log multi-RPC timeout (`RPC_LOG_SCAN_TIMEOUT_MS`, vs the 4s
   * point-read cap; single-RPC stays uncapped, #894) is owned HERE once, not by
   * per-call-site discipline. Used by every `listenForEvents` branch below.
   *
   * TIP-SENSITIVE → `skipPreferred: true` (endpoint stickiness carve-out). The
   * event-lane cursor is advanced against a head read canonical-fresh via
   * `getBlockNumber()` (also `skipPreferred`); if this `[fromBlock, head]` scan
   * were pinned to a lagging sticky backup whose tip is BELOW `head`, a provider
   * that silently clamps `toBlock` to its own tip would return fewer logs, the
   * runner would still persist `lastBlock = head`, and the events in
   * `(backendTip, head]` would be skipped forever. Scanning canonical-order keeps
   * the scan's tip coverage aligned with the head that advances the cursor
   * (mirrors the hub-rotation poller's `skipPreferred` wide-log carve-out).
   */
  private queryFilterWithFailover(
    contract: ethers.Contract,
    label: string,
    eventFilter: ethers.ContractEventName,
    fromBlock: ethers.BlockTag,
    toBlock?: ethers.BlockTag,
  ): Promise<(ethers.Log | ethers.EventLog)[]> {
    return this.readContractWith(
      contract,
      label,
      (c) => c.queryFilter(eventFilter, fromBlock, toBlock),
      { policy: 'wideLogScan', skipPreferred: true },
    );
  }

  /**
   * Does this bound contract's ABI declare an event by this name?
   *
   * Lifted out of the `KCCreated` branch so every branch that reaches for an
   * event a LEGACY binding may not declare asks the same question. Calling
   * `contract.filters.<name>()` on an ABI without that fragment throws, and a
   * throw inside `listenForEvents` aborts the whole scan — so a node bound to
   * an older `DKGKnowledgeAssets` would lose the events it CAN serve because
   * of one it cannot.
   */
  private contractHasEvent(contract: ethers.Contract, name: string): boolean {
    return contract.interface.fragments.some(
      (f) => f.type === 'event' && (f as { name?: string }).name === name,
    );
  }

  /**
   * Which of `names` this adapter's CURRENTLY BOUND contracts cannot produce.
   *
   * Returns the MISSING names (empty array = all supported), so a caller gates
   * on `.length === 0` and can name the specific absent event in its
   * diagnostics instead of reporting an opaque "unsupported".
   *
   * Async, and awaits `init()`: contract bindings are resolved lazily from the
   * Hub on first use. A synchronous variant called at wiring time — before any
   * scan has run — would see no bindings at all and report every name missing,
   * which reads exactly like a genuinely legacy ABI. A feature gate would then
   * disable itself on a perfectly capable node, and nothing in the resulting
   * diagnostics would distinguish the two.
   */
  async supportsEventTypes(names: readonly string[]): Promise<string[]> {
    await this.init();
    const kaStorage = this.contracts.knowledgeAssetStorage;
    if (!kaStorage) return [...names];
    return names.filter((name) => !this.contractHasEvent(kaStorage, name));
  }

  /**
   * The four `DKGKnowledgeAssets` root-mutation events, one name per call.
   *
   * Mirrors the `KnowledgeAssetRegisteredToContextGraph` template above —
   * notably it goes through `queryFilterWithFailover`, whose `wideLogScan`
   * policy and `skipPreferred` carve-out are load-bearing: a scan pinned to a
   * lagging sticky endpoint would return fewer logs while the runner still
   * persisted `lastBlock = head`, and the events in `(backendTip, head]` would
   * be skipped forever with no trace.
   *
   * `kaId` is read from `topics[1]` — the indexed `uint256 id` all four events
   * share — NOT from `parseLog`. The id is the only field a consumer needs to
   * identify the mutated asset, and reading it from the topic keeps it
   * available even when the non-indexed payload fails to decode (a fabricated
   * or truncated log from an untrusted RPC, or an ABI whose non-indexed
   * arguments drifted). `parseLog` is then best-effort, for `merkleRoot` /
   * `author` only.
   *
   * `KnowledgeAssetMerkleRootsUpdated` is never parsed: it carries a dynamic
   * `MerkleRoot[]`, i.e. unbounded decode work driven by an untrusted payload,
   * and no consumer wants the array — the repair path re-reads the committed
   * set from chain regardless.
   */
  private async *yieldKnowledgeAssetRootMutationLogs(
    eventName: KnowledgeAssetRootMutationEventType,
    filter: EventFilter,
  ): AsyncIterable<ChainEvent> {
    const kaStorage = this.contracts.knowledgeAssetStorage;
    if (!kaStorage || !this.contractHasEvent(kaStorage, eventName)) return;

    const logs = await this.queryFilterWithFailover(
      kaStorage,
      `kas.queryFilter(${eventName})`,
      kaStorage.filters[eventName](),
      filter.fromBlock ?? 0,
      filter.toBlock,
    );

    for (const log of logs) {
      const kaIdTopic = log.topics[1];
      if (kaIdTopic == null) continue;
      let kaId: string;
      try {
        kaId = ethers.getBigInt(kaIdTopic).toString();
      } catch {
        // A log whose indexed id is not a 32-byte word is not one of ours.
        // Skipping costs a consumer nothing; THROWING would abort the scan,
        // hold the lane cursor, and stall every later event behind one
        // malformed log — a deterministic stall, not a retryable one.
        continue;
      }

      const data: Record<string, unknown> = {
        kaId,
        txHash: log.transactionHash,
        txIndex: log.transactionIndex,
        logIndex: log.index,
        blockHash: log.blockHash,
      };

      if (eventName !== 'KnowledgeAssetMerkleRootsUpdated') {
        try {
          const parsed = kaStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) {
            if (typeof parsed.args['merkleRoot'] === 'string') {
              data['merkleRoot'] = parsed.args['merkleRoot'];
            }
            if (typeof parsed.args['author'] === 'string') {
              data['author'] = parsed.args['author'];
            }
          }
        } catch {
          // Best-effort enrichment only — `kaId` above is already sufficient
          // to identify the asset, and a consumer re-reads the roots anyway.
        }
      }

      yield { type: eventName, blockNumber: log.blockNumber, data };
    }
  }

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
        const logs = await this.queryFilterWithFailover(
          storage, 'kasV9.queryFilter(KnowledgeBatchCreated)', eventFilter, filter.fromBlock ?? 0, filter.toBlock,
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
          const logs = await this.queryFilterWithFailover(
            cgStorage, 'cgStorage.queryFilter(ContextGraphExpanded)', eventFilter, filter.fromBlock ?? 0, filter.toBlock,
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
          const logs = await this.queryFilterWithFailover(
            cgStorage, 'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)', eventFilter, filter.fromBlock ?? 0, filter.toBlock,
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

          const isGreenfield = this.contractHasEvent(kaStorage, 'KnowledgeAssetCreated');
          const createEventName = isGreenfield
            ? 'KnowledgeAssetCreated'
            : 'KnowledgeAssetCreated';

          const kcFilter = kaStorage.filters[createEventName]();
          const kcLogs = await this.queryFilterWithFailover(
            kaStorage, 'kas.queryFilter(KnowledgeAssetCreated)', kcFilter, fromB, toB,
          );

          // Legacy mint range. `KnowledgeAssetsMinted` is still declared on the
          // greenfield ABI but never emitted by `createKnowledgeAsset`, so
          // this map stays empty there and the per-log fallback below derives
          // the (single-KA) range + owner from the create id + Transfer.
          const mintByTx = new Map<string, { publisherAddress: string; startKAId: string; endKAId: string }>();
          if (this.contractHasEvent(kaStorage, 'KnowledgeAssetsMinted')) {
            const mintFilter = kaStorage.filters.KnowledgeAssetsMinted();
            const mintLogs = await this.queryFilterWithFailover(
              kaStorage, 'kas.queryFilter(KnowledgeAssetsMinted)', mintFilter, fromB, toB,
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
              const transferLogs = await this.queryFilterWithFailover(
                kaStorage, 'kas.queryFilter(Transfer)', transferFilter, fromB, toB,
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
          const logs = await this.queryFilterWithFailover(
            registry, 'cgNameRegistry.queryFilter(NameClaimed)', eventFilter, filter.fromBlock ?? 0, filter.toBlock,
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
          const logs = await this.queryFilterWithFailover(
            cgStorage, 'cgStorage.queryFilter(ContextGraphCreated)', eventFilter, filter.fromBlock ?? 0, filter.toBlock,
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
          const logs = await this.queryFilterWithFailover(
            profileStorage, 'profileStorage.queryFilter(RelayCapabilityUpdated)', eventFilter, filter.fromBlock ?? 0, filter.toBlock,
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

      // Chain-triggered re-verification of a held Knowledge Asset (#2435).
      // One membership test rather than four near-identical branches, so the
      // adapter and the poller lane that subscribes to it are gated by the
      // SAME constant: removing a name stops both the yield and the
      // subscription, instead of leaving a lane asking for a name nothing
      // produces — which looks exactly like "there were no such events".
      if ((KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES as readonly string[]).includes(eventType)) {
        yield* this.yieldKnowledgeAssetRootMutationLogs(
          eventType as KnowledgeAssetRootMutationEventType,
          filter,
        );
      }
    }
  }
}
