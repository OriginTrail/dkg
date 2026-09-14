// SPDX-License-Identifier: Apache-2.0

import { ethers, type Contract } from 'ethers';
import type { ChainEvent } from './chain-adapter.js';
import type { ContractCache } from './evm-adapter-types.js';
import type { EvmHubContractKey } from './evm-hub-contract-bindings.js';

/**
 * The read boundary a scan borrows from the adapter: cancellation-aware wide
 * log queries over the requested block range. The returned iterable owns the
 * per-log cancellation checkpoints, so every parsed log crosses them.
 */
export interface EvmEventScan {
  readonly signal?: AbortSignal;
  query(
    contract: Contract,
    label: string,
    filter: ethers.ContractEventName,
  ): AsyncIterable<ethers.Log | ethers.EventLog>;
}

/** One supported EVM event: its aliases, the Hub binding it reads and the scan that parses it. */
interface EvmEventDescriptorShape {
  readonly aliases: readonly [string, ...string[]];
  readonly binding: EvmHubContractKey;
  scan(contract: Contract, scan: EvmEventScan): AsyncIterable<ChainEvent>;
}

function parseLog(contract: Contract, log: ethers.Log | ethers.EventLog): ethers.LogDescription | null {
  return contract.interface.parseLog({ topics: [...log.topics], data: log.data });
}

/**
 * Every supported event is defined exactly once, here. Capability selection
 * for a scan and dispatch by requested alias are both derived from this table, so an event
 * cannot become dispatchable without its binding, or bound without its scan.
 * Declaration order is the Hub read order of a multi-capability scan.
 */
export const EVM_EVENT_DESCRIPTORS = [
  {
    // RFC 04 v0.3 / Issue #461 — Network State Registry events.
    aliases: ['RelayCapabilityUpdated'],
    binding: 'profileStorage',
    async *scan(profileStorage: Contract, scan: EvmEventScan) {
      for await (const log of scan.query(
        profileStorage, 'profileStorage.queryFilter(RelayCapabilityUpdated)', profileStorage.filters.RelayCapabilityUpdated(),
      )) {
        const parsed = parseLog(profileStorage, log);
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
    },
  },
  {
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
    aliases: ['KCCreated', 'KnowledgeAssetCreated'],
    binding: 'knowledgeAssetStorage',
    async *scan(kaStorage: Contract, scan: EvmEventScan) {
      const hasEvent = (name: string) =>
        kaStorage.interface.fragments.some(
          (f) => f.type === 'event' && (f as { name?: string }).name === name,
        );

      const kcFilter = kaStorage.filters.KnowledgeAssetCreated();
      // Execute the primary query before auxiliary ownership reads. For an
      // unbounded scan this pins the returned create set to an equal-or-earlier
      // head, so no create can appear without ownership evidence merely because
      // the chain advanced between component queries.
      const kcLogs: Array<ethers.Log | ethers.EventLog> = [];
      for await (const log of scan.query(
        kaStorage, 'kas.queryFilter(KnowledgeAssetCreated)', kcFilter,
      )) kcLogs.push(log);
      // Legacy mint range. `KnowledgeAssetsMinted` is still declared on the
      // greenfield ABI but never emitted by `createKnowledgeAsset`, so
      // this map stays empty there and the per-log fallback below derives
      // the (single-KA) range + owner from the create id + Transfer.
      const mintByTx = new Map<string, { publisherAddress: string; startKAId: string; endKAId: string }>();
      if (hasEvent('KnowledgeAssetsMinted')) {
        const mintFilter = kaStorage.filters.KnowledgeAssetsMinted();
        for await (const ml of scan.query(
          kaStorage, 'kas.queryFilter(KnowledgeAssetsMinted)', mintFilter,
        )) {
          const mp = parseLog(kaStorage, ml);
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
      if (hasEvent('Transfer')) {
        try {
          const transferFilter = kaStorage.filters.Transfer(ethers.ZeroAddress);
          for await (const tl of scan.query(kaStorage, 'kas.queryFilter(Transfer)', transferFilter)) {
            const tp = parseLog(kaStorage, tl);
            if (tp && tp.args.tokenId != null) {
              ownerByTokenId.set(tp.args.tokenId.toString(), String(tp.args.to));
            }
          }
        } catch {
          scan.signal?.throwIfAborted();
          // Best-effort — the `author` topic on the create event is the
          // fallback when Transfer enumeration is unavailable.
        }
      }

      for (const log of kcLogs) {
        const parsed = parseLog(kaStorage, log);
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
    },
  },
  {
    // V8-only event — emitted by archived KnowledgeAssetsStorage. When the
    // V8 contract is absent (the V10-only deploy path after this PR), this
    // scan yields nothing and consumers must rely on V10 `KCCreated`.
    aliases: ['KnowledgeBatchCreated'],
    binding: 'knowledgeAssetsStorage',
    async *scan(storage: Contract, scan: EvmEventScan) {
      for await (const log of scan.query(
        storage, 'kasV9.queryFilter(KnowledgeBatchCreated)', storage.filters.KnowledgeBatchCreated(),
      )) {
        const parsed = parseLog(storage, log);
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
    },
  },
  {
    aliases: ['NameClaimed', 'ContextGraphNameClaimed'],
    binding: 'contextGraphNameRegistry',
    async *scan(registry: Contract, scan: EvmEventScan) {
      for await (const log of scan.query(
        registry, 'cgNameRegistry.queryFilter(NameClaimed)', registry.filters.NameClaimed(),
      )) {
        const parsed = parseLog(registry, log);
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
    },
  },
  {
    aliases: ['ContextGraphExpanded'],
    binding: 'contextGraphStorage',
    async *scan(cgStorage: Contract, scan: EvmEventScan) {
      for await (const log of scan.query(
        cgStorage, 'cgStorage.queryFilter(ContextGraphExpanded)', cgStorage.filters.ContextGraphExpanded(),
      )) {
        const parsed = parseLog(cgStorage, log);
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
    },
  },
  {
    // Phase B (chain-driven VM reconciliation): the canonical
    // "a KA was bound to a CG" signal. Both `contextGraphId` and `kaId`
    // are indexed, so the poller can subscribe with a topic filter on its
    // subscribed CG ids (no global firehose). Emitted by
    // `registerKnowledgeAssetToContextGraph` in the V10 publish flow.
    aliases: ['KnowledgeAssetRegisteredToContextGraph'],
    binding: 'contextGraphStorage',
    async *scan(cgStorage: Contract, scan: EvmEventScan) {
      for await (const log of scan.query(
        cgStorage, 'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)', cgStorage.filters.KnowledgeAssetRegisteredToContextGraph(),
      )) {
        const parsed = parseLog(cgStorage, log);
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
    },
  },
  {
    aliases: ['ContextGraphCreated'],
    binding: 'contextGraphStorage',
    async *scan(cgStorage: Contract, scan: EvmEventScan) {
      for await (const log of scan.query(
        cgStorage, 'cgStorage.queryFilter(ContextGraphCreated)', cgStorage.filters.ContextGraphCreated(),
      )) {
        const parsed = parseLog(cgStorage, log);
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
    },
  },
] as const satisfies readonly EvmEventDescriptorShape[];

export type EvmEventDescriptor = (typeof EVM_EVENT_DESCRIPTORS)[number];
export type EvmEventContractKey = EvmEventDescriptor['binding'];
export type EvmEventCapabilityKey = EvmHubContractKey;
export type EvmEventContracts = Readonly<Pick<ContractCache, EvmEventCapabilityKey>>;

const DESCRIPTOR_BY_ALIAS: ReadonlyMap<string, EvmEventDescriptor> = new Map(
  EVM_EVENT_DESCRIPTORS.flatMap(descriptor => descriptor.aliases.map(alias => [alias, descriptor] as const)),
);

/** The descriptor a requested event type dispatches to; unsupported names have none. */
export function evmEventDescriptorFor(eventType: string): EvmEventDescriptor | undefined {
  return DESCRIPTOR_BY_ALIAS.get(eventType);
}

export interface EvmEventPlan {
  readonly descriptors: readonly EvmEventDescriptor[];
  readonly bindings: readonly EvmEventCapabilityKey[];
}

/** One canonical descriptor and binding plan for requested event aliases. */
export function selectEvmEventPlan(eventTypes: readonly string[]): EvmEventPlan {
  const selectedAliases = new Set(eventTypes);
  const descriptors = Object.freeze(EVM_EVENT_DESCRIPTORS.filter(
    descriptor => descriptor.aliases.some(alias => selectedAliases.has(alias)),
  ));
  const bindings = Object.freeze([...new Set(descriptors.map(descriptor => descriptor.binding))]);
  return Object.freeze({ descriptors, bindings });
}

/** Unique descriptors selected by requested aliases, in declaration order. */
export function selectEvmEventDescriptors(
  eventTypes: readonly string[],
): readonly EvmEventDescriptor[] {
  return selectEvmEventPlan(eventTypes).descriptors;
}

/** The Hub bindings a scan for these event types must resolve, in declaration order. */
export function eventContractKeysFor(eventTypes: readonly string[]): readonly EvmEventCapabilityKey[] {
  return selectEvmEventPlan(eventTypes).bindings;
}
