// SPDX-License-Identifier: Apache-2.0

import { ethers, type Contract } from 'ethers';
import type { ChainEvent } from './chain-adapter.js';
import type { EvmHubContractKey } from './evm-hub-contract-bindings.js';
import { scanKnowledgeAssetCreatedEvents } from './evm-knowledge-asset-created-scanner.js';

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
    // The scanner selects one legacy-mint or greenfield-transfer evidence
    // strategy for the bound deployment and projects the shared event shape.
    aliases: ['KCCreated', 'KnowledgeAssetCreated'],
    binding: 'knowledgeAssetStorage',
    scan: scanKnowledgeAssetCreatedEvents,
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
/**
 * The only Hub bindings the event surface can select, derived from the table
 * rather than declared beside it: a Hub key no descriptor reads (`token`,
 * `staking`, …) is not an event binding and cannot appear in a plan.
 */
export type EvmEventContractKey = EvmEventDescriptor['binding'];

/** What a scan of the requested aliases needs: which descriptors run, and which bindings they read. */
export interface EvmEventPlan {
  readonly descriptors: readonly EvmEventDescriptor[];
  readonly bindings: readonly EvmEventContractKey[];
}

/**
 * The one canonical projection of the table. Aliases of the same descriptor
 * collapse to a single entry, descriptors keep their declaration order (the
 * Hub read order of a multi-capability scan) and a binding two descriptors
 * share is resolved once.
 */
export function selectEvmEventPlan(eventTypes: readonly string[]): EvmEventPlan {
  const selectedAliases = new Set(eventTypes);
  const descriptors = Object.freeze(EVM_EVENT_DESCRIPTORS.filter(
    descriptor => descriptor.aliases.some(alias => selectedAliases.has(alias)),
  ));
  const bindings = Object.freeze([...new Set(descriptors.map(descriptor => descriptor.binding))]);
  return Object.freeze({ descriptors, bindings });
}
