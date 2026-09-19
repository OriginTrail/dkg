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
export type ChainEventLogFamily = 'context-graph-authority' | 'hub';

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

export interface HubRotationEvent {
  readonly name: HubRotationEventName;
  readonly contractName: string;
  /** Lowercased. The zero address for the two `…Removed` events. */
  readonly contractAddress: string;
  readonly assetStorage: boolean;
  readonly blockNumber: number;
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
  readonly #byAddress = new Map<string, ChainEventLogSource<unknown>>();

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
    this.#byAddress.set(address, Object.freeze({
      ...source,
      address,
      topic0: Object.freeze(source.topic0.map((topic) => topic.toLowerCase())),
    }) as ChainEventLogSource<unknown>);
    return this;
  }

  /** The exact filter one tick sends: the address array and the OR'd topic0 set. */
  topicSet(): ChainEventLogTopicSet {
    const addresses = new Set<string>();
    const topic0 = new Set<string>();
    for (const source of this.#byAddress.values()) {
      addresses.add(source.address);
      for (const topic of source.topic0) topic0.add(topic);
    }
    return Object.freeze({
      addresses: Object.freeze([...addresses].sort()),
      topic0: Object.freeze([...topic0].sort()),
    });
  }

  addressesFor(family: ChainEventLogFamily): readonly string[] {
    return Object.freeze([...this.#byAddress.values()]
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
    const source = this.#byAddress.get(address);
    const topic0 = row.topics[0]?.toLowerCase();
    if (source === undefined || topic0 === undefined) return undefined;
    return source.topic0.includes(topic0) ? source : undefined;
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
    logIndex: row.logIndex,
  });
}
