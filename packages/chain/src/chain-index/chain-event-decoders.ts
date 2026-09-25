// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

import type { RawContextGraphAuthorityIndexEvent } from
  '../context-graph-authority-index-reducer.js';
import {
  contextGraphAuthorityEventTopics,
  decodeContextGraphAuthorityIndexLog,
} from '../evm-context-graph-authority-source.js';
import {
  normalizeChainEventLogAddress,
  type ChainEventLogRow,
  type ChainEventLogTopicSet,
} from './chain-event-log.js';

/**
 * Which reducer a row belongs to. One `eth_getLogs` covers every family, so the
 * family is recovered on the way OUT of the log, by emitter address and then by
 * topic0 — never by topic0 alone.
 *
 * That order is not a style choice. ERC-721 `Transfer` and ERC-20
 * `Transfer`/`Approval` share a topic0 across `ContextGraphStorage`,
 * `DKGKnowledgeAssets`, the PCA NFT and the TRAC token, so a topic0-keyed
 * registry would feed a token transfer to the Context Graph ownership reducer.
 */
export type ChainEventLogFamily =
  | 'context-graph-authority'
  | 'context-graph-ka'
  | 'knowledge-asset'
  | 'hub';

/** Every family the tick tracks coverage for, in a stable order. */
export const CHAIN_EVENT_LOG_FAMILIES = Object.freeze([
  'context-graph-authority',
  'context-graph-ka',
  'knowledge-asset',
  'hub',
] as const);

/** The six Hub events. The old poller read four (`hub-rotation-poller.ts:189-195`). */
export const HUB_ROTATION_EVENT_NAMES = Object.freeze([
  'ContractChanged',
  'NewContract',
  'ContractRemoved',
  'AssetStorageChanged',
  'NewAssetStorage',
  'AssetStorageRemoved',
] as const);

export type HubRotationEventName = typeof HUB_ROTATION_EVENT_NAMES[number];

/** The `DKGKnowledgeAssets` signatures that move a KA's merkle-root stack. */
export const KNOWLEDGE_ASSET_EVENT_NAMES = Object.freeze([
  'KnowledgeAssetCreated',
  'KnowledgeAssetUpdated',
  'KnowledgeAssetMerkleRootsUpdated',
  'KnowledgeAssetMerkleRootAdded',
  'KnowledgeAssetMerkleRootRemoved',
] as const);

export type KnowledgeAssetEventName = typeof KNOWLEDGE_ASSET_EVENT_NAMES[number];

/** Where in the log a decoded event sat. Fold order is (block, logIndex). */
interface ChainEventLogPosition {
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly transactionHash: string;
  readonly settled: boolean;
}

/**
 * `KnowledgeAssetRegisteredToContextGraph` — the one event behind
 * `kaToContextGraph`, `getContextGraphKaCount` and `getContextGraphKaAt`.
 *
 * Both ids are indexed, and `_contextGraphKAList` is append-only with this
 * emit as its sole writer (`ContextGraphStorage.sol:360`), so the i-th such log
 * for a graph in (block, logIndex) order IS `getContextGraphKaAt(cg, i)`.
 */
export interface ContextGraphKaRegistration extends ChainEventLogPosition {
  readonly contextGraphId: bigint;
  readonly kaId: bigint;
}

/** One entry of the admin `KnowledgeAssetMerkleRootsUpdated` replacement list. */
export interface KnowledgeAssetMerkleRootEntry {
  readonly merkleRoot: string;
  /** Contract gap #2674: only this unused admin path carries a publisher. */
  readonly publisher?: string;
}

export interface KnowledgeAssetEvent extends ChainEventLogPosition {
  readonly name: KnowledgeAssetEventName;
  readonly kaId: bigint;
  /**
   * The NEW latest root for create/update/add — and the REMOVED one for
   * `…MerkleRootRemoved`, where the new latest can only come from the folded
   * history below it.
   */
  readonly merkleRoot?: string;
  /** Whole-stack replacement, `…MerkleRootsUpdated` only. */
  readonly merkleRoots?: readonly KnowledgeAssetMerkleRootEntry[];
  /** EIP-712 attested author; carried (indexed) by create and update only. */
  readonly author?: string;
}

export interface HubRotationEvent {
  readonly name: HubRotationEventName;
  readonly contractName: string;
  /** Lowercased. The zero address for the two `…Removed` events. */
  readonly contractAddress: string;
  readonly assetStorage: boolean;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logIndex: number;
}

/** One registered source: an address, the topic0s it contributes, its decoder. */
interface ChainEventLogSource<TEvent> {
  readonly family: ChainEventLogFamily;
  readonly address: string;
  readonly topic0: readonly string[];
  decode(row: ChainEventLogRow): TEvent;
}

/**
 * The tick's dispatch table.
 *
 * It is built from the SAME `ethers.Interface`s the adapter already holds and
 * the SAME decoders the demand-driven reader used, so a row folded out of the
 * log is byte-identical to one folded straight off `eth_getLogs`. Rewriting the
 * decoders here would have made that an assertion instead of a fact.
 */
export class ChainEventDecoderRegistry {
  /**
   * Sources per address, not ONE source per address.
   *
   * `ContextGraphStorage` emits the seven authority signatures AND
   * `KnowledgeAssetRegisteredToContextGraph`, which belong to different
   * reducers with different coverage floors: the authority fold resumes from
   * the #2670 checkpoint, while a KA ordinal is only correct from the graph's
   * creation block. Collapsing them into one family would make one of those two
   * answers lie about what history it actually holds.
   */
  readonly #byAddress = new Map<string, ChainEventLogSource<unknown>[]>();

  /** Register `ContextGraphStorage`'s seven authority signatures (PR #2670's set). */
  registerContextGraphAuthority(
    address: string,
    contractInterface: ethers.Interface,
  ): this {
    return this.#register({
      family: 'context-graph-authority',
      address,
      topic0: contextGraphAuthorityEventTopics(contractInterface),
      decode: (row) => decodeContextGraphAuthorityIndexLog(
        contractInterface,
        chainEventLogRowAsEthersLog(row),
      ),
    });
  }

  /**
   * Register `KnowledgeAssetRegisteredToContextGraph` — the SECOND family on
   * the `ContextGraphStorage` address, beside the authority signatures.
   */
  registerContextGraphKnowledgeAssets(
    address: string,
    contractInterface: ethers.Interface,
  ): this {
    const fragment = contractInterface.getEvent('KnowledgeAssetRegisteredToContextGraph');
    if (fragment === null) {
      throw new Error('ContextGraphStorage ABI is missing KnowledgeAssetRegisteredToContextGraph');
    }
    const topic0 = fragment.topicHash.toLowerCase();
    const canonical = hasCanonicalRegistrationShape(fragment) ? topic0 : undefined;
    return this.#register<ContextGraphKaRegistration>({
      family: 'context-graph-ka',
      address,
      topic0: [topic0],
      decode: (row) => decodeContextGraphKaRegistration(contractInterface, row, canonical),
    });
  }

  /** Register the five `DKGKnowledgeAssets` root signatures. */
  registerKnowledgeAssets(address: string, contractInterface: ethers.Interface): this {
    const topicByName = new Map<string, KnowledgeAssetEventName>();
    const topic0 = KNOWLEDGE_ASSET_EVENT_NAMES.flatMap((name) => {
      const fragment = contractInterface.getEvent(name);
      // The greenfield and legacy asset-storage ABIs differ, and the three
      // admin signatures have no caller in the current contract set. A missing
      // one is a smaller subscription, not a broken node — what it costs is
      // recorded by this family's coverage, not by a crash at wiring time.
      if (fragment === null) return [];
      topicByName.set(fragment.topicHash.toLowerCase(), name);
      return [fragment.topicHash.toLowerCase()];
    });
    if (!topicByName.has(
      contractInterface.getEvent('KnowledgeAssetCreated')?.topicHash.toLowerCase() ?? '',
    )) {
      // Without the create there is no root-stack bottom and no allocator
      // floor, so every answer this family could give would be a guess.
      throw new Error('DKGKnowledgeAssets ABI is missing KnowledgeAssetCreated');
    }
    return this.#register<KnowledgeAssetEvent>({
      family: 'knowledge-asset',
      address,
      topic0,
      decode: (row) => decodeKnowledgeAssetLog(contractInterface, topicByName, row),
    });
  }

  registerHub(address: string, contractInterface: ethers.Interface): this {
    const topicByName = new Map<string, HubRotationEventName>();
    const topic0 = HUB_ROTATION_EVENT_NAMES.map((name) => {
      const fragment = contractInterface.getEvent(name);
      if (fragment === null) throw new Error(`Hub ABI is missing rotation event ${name}`);
      topicByName.set(fragment.topicHash.toLowerCase(), name);
      return fragment.topicHash.toLowerCase();
    });
    return this.#register({
      family: 'hub',
      address,
      topic0,
      decode: (row) => decodeHubRotationLog(contractInterface, topicByName, row),
    });
  }

  #register<TEvent>(source: ChainEventLogSource<TEvent>): this {
    const address = normalizeChainEventLogAddress(source.address);
    if (address === undefined) throw new Error('Chain event log source address is invalid');
    const topic0 = Object.freeze(source.topic0.map((topic) => topic.toLowerCase()));
    const registered = this.#byAddress.get(address) ?? [];
    for (const existing of registered) {
      // Two families claiming one topic at one address would make `familyOf`
      // order-dependent, which is how a row silently reaches the wrong reducer.
      const clash = topic0.find((topic) => existing.topic0.includes(topic));
      if (clash !== undefined) {
        throw new Error(
          `Chain event log topic ${clash} is already claimed by family ${existing.family} `
          + `at ${address}`,
        );
      }
    }
    // No separate "family already registered" check: re-registering a family
    // necessarily re-offers its own topics, so the clash above is the only way
    // in. A second check would be unreachable, and an unreachable guard reads
    // like protection that is not there.
    registered.push(Object.freeze({
      ...source,
      address,
      topic0,
    }) as ChainEventLogSource<unknown>);
    this.#byAddress.set(address, registered);
    return this;
  }

  /** The exact filter one tick sends: the address array and the OR'd topic0 set. */
  topicSet(): ChainEventLogTopicSet {
    const addresses = new Set<string>();
    const topic0 = new Set<string>();
    for (const sources of this.#byAddress.values()) {
      for (const source of sources) {
        addresses.add(source.address);
        for (const topic of source.topic0) topic0.add(topic);
      }
    }
    return Object.freeze({
      addresses: Object.freeze([...addresses].sort()),
      topic0: Object.freeze([...topic0].sort()),
    });
  }

  /**
   * The topic0s ONE family claims at ONE address, sorted; empty when nothing
   * is registered there.
   *
   * A reader that pre-filters the log by topic0 must take the set from here,
   * the same table {@link ChainEventDecoderRegistry.decodeContextGraphKaRegistrations}
   * dispatches on, so a row the filter lets through is exactly a row the
   * decoder would have claimed from an unfiltered read.
   */
  topic0For(family: ChainEventLogFamily, address: string): readonly string[] {
    const normalized = normalizeChainEventLogAddress(address);
    if (normalized === undefined) return Object.freeze([]);
    return Object.freeze((this.#byAddress.get(normalized) ?? [])
      .filter((source) => source.family === family)
      .flatMap((source) => source.topic0)
      .sort());
  }

  addressesFor(family: ChainEventLogFamily): readonly string[] {
    return Object.freeze([...this.#byAddress.values()]
      .flat()
      .filter((source) => source.family === family)
      .map((source) => source.address)
      .sort());
  }

  /**
   * The family a row belongs to, or `undefined` when nothing claims it.
   *
   * Unclaimed is NORMAL, not an error: the filter is a cross product of
   * addresses and topics (`eth_getLogs` cannot pair one topic with one
   * address), so a contract that happens to emit another contract's topic0
   * lands in the same response. Those rows are stored — they were fetched, and
   * the log is the record of what was fetched — and simply routed to nobody.
   */
  familyOf(row: ChainEventLogRow): ChainEventLogFamily | undefined {
    const source = this.#sourceFor(row);
    return source?.family;
  }

  /** Decode every row of one family, in log order, skipping foreign rows. */
  decodeContextGraphAuthority(
    rows: readonly ChainEventLogRow[],
  ): readonly RawContextGraphAuthorityIndexEvent[] {
    return this.#decodeFamily<RawContextGraphAuthorityIndexEvent>(
      rows,
      'context-graph-authority',
    );
  }

  decodeHubRotations(rows: readonly ChainEventLogRow[]): readonly HubRotationEvent[] {
    return this.#decodeFamily<HubRotationEvent>(rows, 'hub');
  }

  decodeContextGraphKaRegistrations(
    rows: readonly ChainEventLogRow[],
  ): readonly ContextGraphKaRegistration[] {
    return this.#decodeFamily<ContextGraphKaRegistration>(rows, 'context-graph-ka');
  }

  decodeKnowledgeAssets(rows: readonly ChainEventLogRow[]): readonly KnowledgeAssetEvent[] {
    return this.#decodeFamily<KnowledgeAssetEvent>(rows, 'knowledge-asset');
  }

  #decodeFamily<TEvent>(
    rows: readonly ChainEventLogRow[],
    family: ChainEventLogFamily,
  ): readonly TEvent[] {
    const decoded: TEvent[] = [];
    for (const row of rows) {
      const source = this.#sourceFor(row);
      if (source === undefined || source.family !== family) continue;
      decoded.push(source.decode(row) as TEvent);
    }
    return Object.freeze(decoded);
  }

  #sourceFor(row: ChainEventLogRow): ChainEventLogSource<unknown> | undefined {
    const address = normalizeChainEventLogAddress(row.address);
    if (address === undefined) return undefined;
    const sources = this.#byAddress.get(address);
    const topic0 = row.topics[0]?.toLowerCase();
    if (sources === undefined || topic0 === undefined) return undefined;
    return sources.find((source) => source.topic0.includes(topic0));
  }
}

/**
 * Present a stored row to an ethers decoder written against `ethers.Log`.
 *
 * Only the fields the existing decoders read are supplied. Reconstructing a
 * real `ethers.Log` would need a provider, which is exactly what the log exists
 * to stop these code paths from touching.
 */
function chainEventLogRowAsEthersLog(row: ChainEventLogRow): ethers.Log {
  return {
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    index: row.logIndex,
    transactionHash: row.transactionHash,
    address: ethers.getAddress(row.address),
    topics: [...row.topics],
    data: row.data,
  } as unknown as ethers.Log;
}

function positionOf(row: ChainEventLogRow): ChainEventLogPosition {
  return {
    blockNumber: row.blockNumber,
    logIndex: row.logIndex,
    transactionHash: row.transactionHash,
    settled: row.settled,
  };
}

const CANONICAL_TOPIC = /^0x[0-9a-f]{64}$/;

/**
 * `KnowledgeAssetRegisteredToContextGraph(uint256 indexed contextGraphId,
 * uint256 indexed kaId)`, non-anonymous, exactly as the ABI this package ships.
 *
 * Only then is the fast decode below the same function as `parseLog`: an
 * indexed uint256 IS its 32-byte topic word, read big-endian and unsigned. Any
 * other shape (a renamed, reordered or re-typed ABI) keeps the ethers decode.
 */
function hasCanonicalRegistrationShape(fragment: ethers.EventFragment): boolean {
  const [contextGraphId, kaId, ...rest] = fragment.inputs;
  return !fragment.anonymous
    && rest.length === 0
    && contextGraphId?.name === 'contextGraphId'
    && contextGraphId.type === 'uint256'
    && contextGraphId.indexed === true
    && kaId?.name === 'kaId'
    && kaId.type === 'uint256'
    && kaId.indexed === true;
}

function decodeContextGraphKaRegistration(
  contractInterface: ethers.Interface,
  row: ChainEventLogRow,
  canonicalTopic0: string | undefined,
): ContextGraphKaRegistration {
  // The fast path, for the row the tick actually stores: three lowercase
  // 32-byte topics under this event's own topic0 and no data. `parseLog` on it
  // resolves the fragment by hashing the signature of every event in the ABI
  // (~150 us a row, 4.5 s for a 30k-registration graph); what it returns for
  // this shape is the two topic words as unsigned integers, which is all this
  // does. Anything else, malformed rows included, takes `parseLog` and gets its
  // answer or its error, as before.
  const [topic0, contextGraphTopic, kaTopic] = row.topics;
  if (canonicalTopic0 !== undefined
    && row.topics.length === 3
    && topic0 === canonicalTopic0
    && row.data === '0x'
    && CANONICAL_TOPIC.test(contextGraphTopic!)
    && CANONICAL_TOPIC.test(kaTopic!)) {
    return Object.freeze({
      ...positionOf(row),
      contextGraphId: BigInt(contextGraphTopic!),
      kaId: BigInt(kaTopic!),
    });
  }
  const parsed = contractInterface.parseLog({ topics: [...row.topics], data: row.data });
  if (parsed === null) {
    throw new Error('KnowledgeAssetRegisteredToContextGraph could not be decoded');
  }
  const contextGraphId = parsed.args.contextGraphId ?? parsed.args[0];
  const kaId = parsed.args.kaId ?? parsed.args[1];
  return Object.freeze({
    ...positionOf(row),
    contextGraphId: BigInt(contextGraphId),
    kaId: BigInt(kaId),
  });
}

/** `bytes32` as the lowercase 0x hex the root comparisons in the node use. */
function normalizeMerkleRoot(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

/**
 * The WHOLE replacement list, or nothing at all.
 *
 * `…MerkleRootsUpdated` replaces a KA's entire root stack, so a list that
 * decodes to fewer entries than the chain emitted is not a smaller answer — it
 * is a DIFFERENT stack: a different top root and every `rootIndex` shifted by
 * however many entries were dropped. Of everything this log serves, that is the
 * only value that could hand a verifier a root the chain does not hold, so one
 * unreadable entry voids the event instead of being skipped past. The reducer
 * sees no replacement and marks the KA unservable, and the caller goes live.
 *
 * The publisher is deliberately not part of this: contract gap #2674 leaves it
 * legitimately absent, and it names no root.
 */
/**
 * A tuple field by name, falling back to its position.
 *
 * ethers' `Result` THROWS on an out-of-range positional read rather than
 * answering `undefined`, and this decoder reads by position precisely because
 * the entry's shape is not fixed across ABI revisions. Without the guard, one
 * `merkleRoots` list narrower than expected escapes the decoder entirely and
 * refuses every KA on the node instead of only the one it belongs to — the
 * containment rule `knowledge-asset-reducer.ts` opens with.
 */
function readMerkleRootEntryField(item: unknown, name: string, index: number): unknown {
  try {
    const named = (item as Record<string, unknown>)[name];
    if (named !== undefined) return named;
    return (item as Record<number, unknown>)[index];
  } catch {
    return undefined;
  }
}

function decodeMerkleRootEntries(
  value: unknown,
): readonly KnowledgeAssetMerkleRootEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: KnowledgeAssetMerkleRootEntry[] = [];
  for (const item of value) {
    const merkleRoot = normalizeMerkleRoot(readMerkleRootEntryField(item, 'merkleRoot', 1));
    if (merkleRoot === undefined) return undefined;
    const publisher = normalizeChainEventLogAddress(
      String(readMerkleRootEntryField(item, 'publisher', 0) ?? ''),
    );
    entries.push(Object.freeze(
      publisher === undefined ? { merkleRoot } : { merkleRoot, publisher },
    ));
  }
  return Object.freeze(entries);
}

function decodeKnowledgeAssetLog(
  contractInterface: ethers.Interface,
  topicByName: ReadonlyMap<string, KnowledgeAssetEventName>,
  row: ChainEventLogRow,
): KnowledgeAssetEvent {
  const topic0 = row.topics[0]?.toLowerCase() ?? '';
  const name = topicByName.get(topic0);
  if (name === undefined) throw new Error('DKGKnowledgeAssets returned an unknown event');
  const parsed = contractInterface.parseLog({ topics: [...row.topics], data: row.data });
  if (parsed === null) throw new Error(`${name} could not be decoded`);
  const kaId = BigInt(parsed.args.id ?? parsed.args[0]);
  const author = normalizeChainEventLogAddress(String(parsed.args.author ?? ''));
  const merkleRoot = normalizeMerkleRoot(parsed.args.merkleRoot);
  const merkleRoots = name === 'KnowledgeAssetMerkleRootsUpdated'
    ? decodeMerkleRootEntries(parsed.args.merkleRoots ?? parsed.args[1])
    : undefined;
  return Object.freeze({
    ...positionOf(row),
    name,
    kaId,
    ...(merkleRoot === undefined ? {} : { merkleRoot }),
    ...(merkleRoots === undefined ? {} : { merkleRoots }),
    ...(author === undefined ? {} : { author }),
  });
}

function decodeHubRotationLog(
  contractInterface: ethers.Interface,
  topicByName: ReadonlyMap<string, HubRotationEventName>,
  row: ChainEventLogRow,
): HubRotationEvent {
  const topic0 = row.topics[0]?.toLowerCase() ?? '';
  const name = topicByName.get(topic0);
  if (name === undefined) throw new Error('Hub returned an unknown rotation event');
  const parsed = contractInterface.parseLog({ topics: [...row.topics], data: row.data });
  if (parsed === null) throw new Error('Hub rotation event could not be decoded');
  const contractName = parsed.args.contractName ?? parsed.args[0];
  if (typeof contractName !== 'string' || contractName.length === 0) {
    throw new Error('Hub rotation event carries no contract name');
  }
  // `…Changed`/`New…` name the new address as arg 1; `…Removed` names the one
  // being dropped. Both are arg 1, so one read covers all six.
  const rawAddress = parsed.args.newContractAddress
    ?? parsed.args.contractAddress
    ?? parsed.args[1];
  const contractAddress = normalizeChainEventLogAddress(String(rawAddress));
  if (contractAddress === undefined) {
    throw new Error('Hub rotation event carries an invalid contract address');
  }
  return Object.freeze({
    name,
    contractName,
    contractAddress,
    assetStorage: name.startsWith('AssetStorage') || name === 'NewAssetStorage',
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    logIndex: row.logIndex,
  });
}
