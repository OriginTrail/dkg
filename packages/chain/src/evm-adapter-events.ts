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
import type { ChainEventLogFamily } from './chain-index/index.js';
import { readAdaptiveEvmLogRange } from './evm-log-range.js';
import { resolveCapMs } from './rpc-failover-client.js';
import { withRpcRequestTimeout } from './rpc-request-transport.js';

/** One stored row, presented to the SAME parse the live branch uses. */
type ParsedLogLike = { topics: readonly string[]; data: string; blockNumber: number; transactionHash: string };

export class EventsMethods extends EVMChainAdapterBase {
  /**
   * Rows for `[fromBlock, toBlock]` out of the one log, or `undefined` when
   * this reader must keep its own `eth_getLogs`.
   *
   * ALL-OR-NOTHING on purpose. The lane runner advances its cursor to the
   * upper bound it asked for whether or not the scan reached it
   * (`chain-event-lane-runner.ts:289`), so a partial answer here would skip
   * every block between the log's coverage and that bound — permanently, and
   * silently. Serving only a fully-covered range keeps the lane's cursor
   * arithmetic exactly as it was; a short range falls back to the live scan
   * that was there before the log existed.
   */
  private async chainEventLogRows(
    family: ChainEventLogFamily,
    addressKey: 'contextGraphStorageAddress' | 'knowledgeAssetStorageAddress',
    contract: ethers.Contract,
    eventName: string,
    filter: EventFilter,
  ): Promise<readonly ParsedLogLike[] | undefined> {
    const binding = this.chainEventLogBinding;
    if (binding === undefined) return undefined;
    // Coverage is recorded per (family, address), so the binding is usable only
    // while it names the SAME contract the adapter currently resolves. A
    // write-side Hub self-heal can replace the handle before the detached index
    // runtime has rebuilt; in that interval the retired proxy's coverage must
    // fail closed to the live queryFilter below.
    const address = binding[addressKey];
    if (address === undefined) return undefined;
    let currentAddress: string;
    try {
      currentAddress = (await contract.getAddress()).toLowerCase();
    } catch {
      return undefined;
    }
    if (address !== currentAddress) return undefined;
    // ONE topic, not the whole family. A family is a filter of several
    // signatures fetched together, so handing a lane every row at the address
    // would feed it its siblings — a `ContextGraphDeactivated` parsed as a
    // `ContextGraphCreated` is a graph that never existed.
    const topic0 = contract.interface.getEvent(eventName)?.topicHash.toLowerCase();
    if (topic0 === undefined) return undefined;
    const fromBlock = typeof filter.fromBlock === 'number' ? filter.fromBlock : undefined;
    const toBlock = typeof filter.toBlock === 'number' ? filter.toBlock : undefined;
    // An open-ended range has no bound to prove coverage against.
    if (fromBlock === undefined || toBlock === undefined) return undefined;
    const range = await binding.subscription.servableRange(
      family,
      address,
      fromBlock,
      toBlock,
    );
    if (range === undefined || range.throughBlockNumber < toBlock) return undefined;
    const rows = await binding.subscription.readRows(range);
    if (!this.chainEventLogBindingIsCurrent(binding)) return undefined;
    return rows.filter((row) => row.topics[0]?.toLowerCase() === topic0);
  }
  // =====================================================================
  // Events
  // =====================================================================

  /**
   * A WIDE `eth_getLogs` scan with read-failover. Used by every
   * `listenForEvents` branch below.
   *
   * Each provider attempt reads the range through `readAdaptiveEvmLogRange`,
   * which fits it to that provider's eth_getLogs span cap (a 9,000-block lane
   * page is five requests on a 2,000-block cap) and refuses history/plan
   * limits without splitting, so the loop fails over instead. Because one
   * attempt can now be several physical requests, the `wideLogScan` deadline
   * (`RPC_LOG_SCAN_TIMEOUT_MS` multi-RPC, uncapped single-RPC per #894) bounds
   * each physical request rather than the whole attempt; the attempt itself
   * runs under `durablePagedLogScan`, like the authority-index pages.
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
    const requestTimeoutMs = resolveCapMs('wideLogScan', this.providers.length);
    return this.readContractWith(
      contract,
      label,
      (c) => {
        const query = (from: ethers.BlockTag, to?: ethers.BlockTag) => (
          requestTimeoutMs === undefined
            ? c.queryFilter(eventFilter, from, to)
            : withRpcRequestTimeout(
              requestTimeoutMs,
              `${label} getLogs [${String(from)}, ${String(to ?? 'latest')}]`,
              () => c.queryFilter(eventFilter, from, to),
            )
        );
        // An open-ended range has no span to fit; only numeric bounds adapt.
        if (typeof fromBlock !== 'number' || typeof toBlock !== 'number') {
          return query(fromBlock, toBlock);
        }
        return readAdaptiveEvmLogRange({
          provider: c.runner ?? undefined,
          fromBlock,
          toBlock,
          read: query,
        });
      },
      { policy: 'durablePagedLogScan', skipPreferred: true },
    );
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
          // The one log owns this event. `txIndex` is the one field it cannot
          // carry (the stored row has no transaction index), and this lane is
          // explicitly a NUDGE whose consumer re-derives the ordinal with its
          // own sweep — so an absent tiebreaker costs a sweep, not a wrong
          // version. The publish lane, whose `txIndex` IS a last-writer-wins
          // tiebreaker, is deliberately NOT routed here.
          const logged = await this.chainEventLogRows(
            'context-graph-ka',
            'contextGraphStorageAddress',
            cgStorage,
            'KnowledgeAssetRegisteredToContextGraph',
            filter,
          );
          const logs = logged ?? await this.queryFilterWithFailover(
            cgStorage, 'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)',
            cgStorage.filters.KnowledgeAssetRegisteredToContextGraph(),
            filter.fromBlock ?? 0, filter.toBlock,
          );

          for (const log of logs) {
            const parsed = cgStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              const txIndex = (log as { transactionIndex?: number }).transactionIndex;
              yield {
                type: 'KnowledgeAssetRegisteredToContextGraph',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.contextGraphId.toString(),
                  kaId: parsed.args.kaId.toString(),
                  txHash: log.transactionHash,
                  txIndex,
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
          const kcLogs = await this.queryFilterWithFailover(
            kaStorage, 'kas.queryFilter(KnowledgeAssetCreated)', kcFilter, fromB, toB,
          );

          // Legacy mint range. `KnowledgeAssetsMinted` is still declared on the
          // greenfield ABI but never emitted by `createKnowledgeAsset`, so
          // this map stays empty there and the per-log fallback below derives
          // the (single-KA) range + owner from the create id + Transfer.
          const mintByTx = new Map<string, { publisherAddress: string; startKAId: string; endKAId: string }>();
          if (hasEvent('KnowledgeAssetsMinted')) {
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
          // `ContextGraphCreated` is already in the tick's authority topic set,
          // so this lane was the SECOND reader of rows the node had already
          // fetched. Nothing in the yielded shape needs a transaction index.
          const logged = await this.chainEventLogRows(
            'context-graph-authority',
            'contextGraphStorageAddress',
            cgStorage,
            'ContextGraphCreated',
            filter,
          );
          const logs = logged ?? await this.queryFilterWithFailover(
            cgStorage, 'cgStorage.queryFilter(ContextGraphCreated)',
            cgStorage.filters.ContextGraphCreated(),
            filter.fromBlock ?? 0, filter.toBlock,
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
    }
  }
}
