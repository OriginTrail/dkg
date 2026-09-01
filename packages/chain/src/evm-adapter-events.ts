// SPDX-License-Identifier: Apache-2.0

/**
 * Chain event subscription (listenForEvents).
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { InvalidRpcLogResponseError, type ReadOpts } from './rpc-failover-client.js';
import { isRetryableRpcError } from './evm-adapter-rpc.js';
import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers } from 'ethers';
import type { EventFilter, ChainEvent } from './chain-adapter.js';
import type { ContractCache } from './evm-adapter-types.js';

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

/**
 * Every event name `listenForEvents` can serve, mapped to the BOUND CONTRACT
 * that owns it (the property on `this.contracts` whose ABI declares the
 * fragment and whose address the scan filters on).
 *
 * This is the single source of event OWNERSHIP: `supportsEventTypes` consults
 * it so a capability answer about, say, `ContextGraphCreated` is given by the
 * context-graph storage binding rather than by whichever contract one feature
 * happened to care about (PR #2436 review r2 — the earlier implementation
 * answered every name from `knowledgeAssetStorage`, reporting events this
 * adapter genuinely serves as missing). A branch added to `listenForEvents`
 * without a row here will be reported unsupported — which is the correct
 * failure direction for a capability gate, and the parity/unit suites pin the
 * roster below.
 */
/**
 * Served names whose ABI FRAGMENT is spelled differently on the owning
 * contract. `listenForEvents` serves the public name `KCCreated` by scanning
 * the greenfield `KnowledgeAssetCreated` fragment (falling back to the legacy
 * spelling), so the capability probe must accept EITHER declaration — probing
 * for a literal `KCCreated` fragment would report a served event missing
 * (review r3).
 */
const EVENT_ABI_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  KCCreated: ['KnowledgeAssetCreated', 'KCCreated'],
  // Served from ContextGraphNameRegistry, whose ABI spells the fragment
  // `NameClaimed` (review r6 — the probe answered the two public spellings
  // differently across the EVM and mock adapters until this row).
  ContextGraphNameClaimed: ['NameClaimed', 'ContextGraphNameClaimed'],
});

/**
 * Resolve the ABI spelling the bound contract ACTUALLY declares for a
 * served public name (review r5-bot). The capability probe accepts either
 * alias spelling, so every scan branch must build its event filter from
 * the SAME resolution: a fallback-only ABI that passes the gate must scan
 * its declared fragment, not throw on a hard-coded primary name — a throw
 * there turns an advertised capability into a runtime failure on every
 * scan.
 */
function resolveDeclaredAbiEventName(
  hasEvent: (name: string) => boolean,
  publicName: string,
): string | undefined {
  for (const abiName of EVENT_ABI_ALIASES[publicName] ?? [publicName]) {
    if (hasEvent(abiName)) return abiName;
  }
  return undefined;
}

// The `satisfies` clause makes a root-mutation name WITHOUT an ownership row
// a compile error (review r8): adding a fifth name to
// `KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES` breaks this file until the row
// exists, instead of silently probing "unserved" for a name the scan serves.
const EVENT_OWNING_CONTRACT_ROWS = {
  KnowledgeBatchCreated: 'knowledgeAssetsStorage', // V8 archive binding
  ContextGraphExpanded: 'contextGraphStorage',
  KnowledgeAssetRegisteredToContextGraph: 'contextGraphStorage',
  KCCreated: 'knowledgeAssetStorage',
  KnowledgeAssetCreated: 'knowledgeAssetStorage',
  NameClaimed: 'contextGraphNameRegistry',
  ContextGraphNameClaimed: 'contextGraphNameRegistry',
  ContextGraphCreated: 'contextGraphStorage',
  RelayCapabilityUpdated: 'profileStorage',
  KnowledgeAssetUpdated: 'knowledgeAssetStorage',
  KnowledgeAssetMerkleRootAdded: 'knowledgeAssetStorage',
  KnowledgeAssetMerkleRootsUpdated: 'knowledgeAssetStorage',
  KnowledgeAssetMerkleRootRemoved: 'knowledgeAssetStorage',
} as const satisfies Record<KnowledgeAssetRootMutationEventType, keyof ContractCache> &
  Record<string, keyof ContractCache>;

const EVENT_OWNING_CONTRACT: Readonly<Record<string, keyof ContractCache>> =
  Object.freeze(EVENT_OWNING_CONTRACT_ROWS);

/**
 * The full public event vocabulary `listenForEvents` serves — exactly the
 * registry's keys, exported so other representations (the mock adapter's
 * declared set) DERIVE from this one instead of restating it (review r6).
 */
export const SERVED_EVENT_TYPES: readonly string[] =
  Object.freeze(Object.keys(EVENT_OWNING_CONTRACT));

/**
 * The tip-sensitive read the validated scan routes through
 * (`readTipProvider`). The options are a Pick of the CANONICAL transport
 * `ReadOpts` (review r5-bot): a lookalike type with `policy?: string`
 * erased exactly the policy contract this helper exists to centralize —
 * a typo like 'wideLogsScan' satisfied the local shape, and the `as never`
 * cast at the call site kept TypeScript from ever comparing it against
 * the real contract.
 */
type ValidatedLogReader = <T>(
  label: string,
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
  opts?: Pick<ReadOpts, 'policy' | 'isRetryable'>,
) => Promise<T>;
/**
 * A VALIDATED wide raw-log scan (review r3-bot): one place owns the
 * tip-sensitive routing (`readTipProvider` — the canonical carve-out for
 * reads whose coverage must align with the head that advances a cursor),
 * the `wideLogScan` timeout policy, request-envelope validation, and
 * retry classification.
 *
 * Whole-response validation runs INSIDE the per-provider callback: an
 * impossible EVM shape (review r14) or a log that violates the request it
 * claims to answer (review r16 — wrong address, outside the window) is
 * ENDPOINT corruption, thrown as the typed
 * {@link InvalidRpcLogResponseError} and classified retryable EXPLICITLY
 * through `ReadOpts.isRetryable` — no ethers error code is inspected or
 * manufactured — so the read fails over and a lane cursor can never
 * advance on an untrustworthy response. Logs outside the requested topic
 * set remain droppable noise; only a matching topic0 asserts anything.
 *
 * Event-specific callers contribute their address/topics and a
 * `validateMatchedLog` shape check, and DECODE what comes back.
 */
function readValidatedTopicLogs(
reader: ValidatedLogReader,
request: {
  label: string;
  address: string;
  topics: (string | string[])[];
  fromBlock: number;
  toBlock?: number;
  /** Return a corruption description to refuse the response, undefined to accept. */
  validateMatchedLog?: (log: ethers.Log) => string | undefined;
},
): Promise<ethers.Log[]> {
  const matchable = new Set(
    (Array.isArray(request.topics[0]) ? request.topics[0] : [request.topics[0]])
      .filter((topic): topic is string => typeof topic === 'string')
      .map((topic) => topic.toLowerCase()),
  );
  return reader(
    request.label,
    async (provider) => {
      const raw = await provider.getLogs({
        address: request.address,
        topics: request.topics,
        fromBlock: request.fromBlock,
        toBlock: request.toBlock ?? 'latest',
      });
      for (const log of raw) {
        const topic0 = log.topics[0]?.toLowerCase();
        if (topic0 == null || !matchable.has(topic0)) continue;
        if (log.address?.toLowerCase() !== request.address.toLowerCase()
          || log.blockNumber < request.fromBlock
          || (typeof request.toBlock === 'number' && log.blockNumber > request.toBlock)) {
          throw new InvalidRpcLogResponseError(
            `RPC endpoint returned a log outside the requested filter: `
            + `address=${String(log.address).slice(0, 60)} block=${log.blockNumber} `
            + `(requested ${request.address} blocks ${request.fromBlock}..${typeof request.toBlock === 'number' ? request.toBlock : 'latest'})`,
          );
        }
        const corruption = request.validateMatchedLog?.(log);
        if (corruption !== undefined) {
          throw new InvalidRpcLogResponseError(
            `RPC endpoint returned a malformed log at block ${log.blockNumber}: ${corruption}`,
          );
        }
      }
      return raw;
    },
    {
      policy: 'wideLogScan',
      isRetryable: (err) => err instanceof InvalidRpcLogResponseError || isRetryableRpcError(err),
    },
  );
}

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
   * Which of `names` this adapter's `listenForEvents` cannot serve, judged per
   * name against the CLIENT ABI of the bound contract that OWNS that event
   * (`EVENT_OWNING_CONTRACT`).
   *
   * Returns the MISSING names (empty array = all supported), so a caller gates
   * on `.length === 0` and can name the specific absent event in its
   * diagnostics instead of reporting an opaque "unsupported".
   *
   * What this answers — and deliberately does not: it is a **client-side
   * declaration probe** ("this adapter, with these bound contracts and this
   * shipped ABI, can build a filter for the name and has a scan branch that
   * serves it"), not a deployed-bytecode capability proof. A deployment older
   * than the shipped ABI can declare-but-never-emit an event; that shape is
   * indistinguishable from a chain where nobody happens to call the emitter,
   * and consumers of a scan lane must tolerate silence regardless. The failure
   * direction is what matters for a gate: an unbound owning contract, a legacy
   * ABI, or a name this adapter has no branch for all report MISSING.
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
    return names.filter((name) => {
      const owner = EVENT_OWNING_CONTRACT[name];
      if (!owner) return true; // no scan branch serves this name
      const contract = this.contracts[owner];
      if (!contract) return true; // owning contract not bound on this deployment
      const abiNames = EVENT_ABI_ALIASES[name] ?? [name];
      return !abiNames.some((abiName) => this.contractHasEvent(contract, abiName));
    });
  }

  /**
   * The four `DKGKnowledgeAssets` root-mutation events, one name per call.
   *
   * Fetches RAW provider logs (`eth_getLogs` through `readProvider`) rather
   * than `contract.queryFilter`, and this is load-bearing (PR #2436 review
   * r2): ethers' `queryFilter` wraps every matched log in an `EventLog`,
   * whose construction EAGERLY decodes the non-indexed payload — so a
   * `KnowledgeAssetMerkleRootsUpdated` response carrying a huge dynamic
   * `MerkleRoot[]` would be fully decoded by the library before this helper
   * ever read `topics[1]`, defeating the bounded-decode contract. Raw logs
   * decode NOTHING until this code chooses to. The same failover properties
   * the query-filter helper documents are preserved explicitly: policy
   * `wideLogScan` (multi-RPC wide-log timeout) and `skipPreferred` (tip
   * alignment with the head read that advances the lane cursor).
   *
   * `kaId` is read from `topics[1]` — the indexed `uint256 id` all four events
   * share — and the topic must be an exact 32-byte word: `getBigInt` alone
   * would happily parse a short-but-valid hex topic like `0x01` from a
   * malformed RPC into a WRONG asset id (review r2), so wrong-sized topics are
   * skipped, not reinterpreted.
   *
   * `parseLog` is then best-effort enrichment (`merkleRoot` / `author`) for
   * the three single-root events only. `KnowledgeAssetMerkleRootsUpdated` is
   * never parsed: no consumer wants the array — the repair path re-reads the
   * committed set from chain regardless.
   */

  private async *yieldKnowledgeAssetRootMutationLogs(
    requested: readonly KnowledgeAssetRootMutationEventType[],
    filter: EventFilter,
  ): AsyncIterable<ChainEvent> {
    const kaStorage = this.contracts.knowledgeAssetStorage;
    if (!kaStorage) return;

    // ONE topic-OR `eth_getLogs` for every requested-and-declared event
    // (review r6): four sequential wide scans over the same contract and
    // window quadruple the RPC cost of every active tick and re-scan, and
    // make yielded order depend on the constant's ordering. A single OR
    // filter — `topics: [[hash1, …]]` — asks the provider once and yields in
    // PROVIDER LOG ORDER, which is the order a consumer's position compare
    // expects to see anyway.
    const nameByTopic = new Map<string, KnowledgeAssetRootMutationEventType>();
    for (const eventName of requested) {
      if (!this.contractHasEvent(kaStorage, eventName)) continue;
      const topicHash = kaStorage.interface.getEvent(eventName)?.topicHash;
      if (topicHash) nameByTopic.set(topicHash.toLowerCase(), eventName);
    }
    if (nameByTopic.size === 0) return;

    const address = await kaStorage.getAddress();
    const logs = await readValidatedTopicLogs(
      (label, fn, opts) => this.readTipProvider(label, fn, opts),
      {
      label: 'kas.getLogs(KnowledgeAssetRootMutations)',
      address,
      topics: [[...nameByTopic.keys()]],
      fromBlock: filter.fromBlock ?? 0,
      toBlock: filter.toBlock,
        validateMatchedLog: (log) => {
          const kaIdTopic = log.topics[1];
          if (kaIdTopic == null || !ethers.isHexString(kaIdTopic, 32)) {
            return `indexed KA-id topic is ${kaIdTopic == null ? 'missing' : String(kaIdTopic).slice(0, 80)}`;
          }
          return undefined;
        },
      },
    );

    for (const log of logs) {
      const topic0 = log.topics[0]?.toLowerCase();
      const eventName = topic0 == null ? undefined : nameByTopic.get(topic0);
      if (!eventName) continue; // a provider answering outside the OR filter
      const kaIdTopic = log.topics[1];
      // Defense in depth: the per-provider callback above already rejects a
      // wrong-sized indexed-id topic as endpoint corruption (review r14), so
      // for logs that came through it this branch is unreachable. It stays
      // because `getBigInt` alone would parse `0x01` into asset id 1 —
      // never reinterpret a wrong-sized word, whatever the code path.
      if (kaIdTopic == null || !ethers.isHexString(kaIdTopic, 32)) continue;
      const kaId = ethers.getBigInt(kaIdTopic).toString();

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

    // Chain-triggered re-verification of a held Knowledge Asset (#2435).
    // The four root-mutation names are ONE grouped operation — a single
    // topic-OR getLogs (review r6) — so the requested subset is partitioned
    // out ONCE ahead of the per-event dispatcher (review r21) instead of
    // being re-derived inside it and suppressed with a served sentinel.
    // Membership is judged by the SAME constant the poller lane subscribes
    // with: removing a name stops both the yield and the subscription.
    const rootMutationNames = filter.eventTypes.filter(
      (t): t is KnowledgeAssetRootMutationEventType =>
        (KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES as readonly string[]).includes(t),
    );
    if (rootMutationNames.length > 0) {
      yield* this.yieldKnowledgeAssetRootMutationLogs(rootMutationNames, filter);
    }

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
          const createEventName = resolveDeclaredAbiEventName(
            (name) => this.contractHasEvent(kaStorage, name),
            'KCCreated',
          ) ?? 'KnowledgeAssetCreated';

          const kcFilter = kaStorage.filters[createEventName]();
          const kcLogs = await this.queryFilterWithFailover(
            kaStorage, `kas.queryFilter(${createEventName})`, kcFilter, fromB, toB,
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
          const claimEventName = resolveDeclaredAbiEventName(
            (name) => this.contractHasEvent(registry, name),
            'ContextGraphNameClaimed',
          ) ?? 'NameClaimed';
          const eventFilter = registry.filters[claimEventName]();
          const logs = await this.queryFilterWithFailover(
            registry, `cgNameRegistry.queryFilter(${claimEventName})`, eventFilter, filter.fromBlock ?? 0, filter.toBlock,
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

    }
  }
}
