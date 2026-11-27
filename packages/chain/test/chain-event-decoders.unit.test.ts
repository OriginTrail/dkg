// SPDX-License-Identifier: Apache-2.0

/**
 * The `KnowledgeAssetRegisteredToContextGraph` fast decode.
 *
 * The registry skips `parseLog` for the one row shape the tick stores (three
 * lowercase 32-byte topics under the event's own topic0, no data) and reads
 * the two indexed uint256 words directly. The claim is that this is the SAME
 * function as the `parseLog` decode it replaced, for every row: equal results
 * on canonical rows, and the untouched `parseLog` path, results and errors
 * alike, on everything else.
 */

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import type { ChainEventLogRow } from '../src/chain-index/chain-event-log.js';
import { loadAbi } from '../src/evm-adapter-abi.js';

const CG_STORAGE = `0x${'cd'.repeat(20)}`;
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
const TOPIC0 = cgInterface.getEvent('KnowledgeAssetRegisteredToContextGraph')!.topicHash.toLowerCase();
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;

/** The decode as it was before the fast path: `parseLog`, then the named args. */
function parseLogDecode(contractInterface: ethers.Interface, row: ChainEventLogRow) {
  const parsed = contractInterface.parseLog({ topics: [...row.topics], data: row.data });
  if (parsed === null) throw new Error('KnowledgeAssetRegisteredToContextGraph could not be decoded');
  return {
    blockNumber: row.blockNumber,
    logIndex: row.logIndex,
    transactionHash: row.transactionHash,
    settled: row.settled,
    contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
    kaId: BigInt(parsed.args.kaId ?? parsed.args[1]),
  };
}

function outcome(decode: () => unknown): unknown {
  try {
    return { value: decode() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function row(topics: readonly string[], data = '0x', index = 0): ChainEventLogRow {
  return {
    blockNumber: 100 + index,
    blockHash: word(BigInt(index)),
    logIndex: index % 7,
    transactionHash: word(BigInt(index) + 1n),
    address: CG_STORAGE,
    topics,
    data,
    settled: index % 3 !== 0,
  };
}

/** mulberry32: small, seedable, and the same sequence on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('KnowledgeAssetRegisteredToContextGraph decode', () => {
  const decoders = new ChainEventDecoderRegistry()
    .registerContextGraphAuthority(CG_STORAGE, cgInterface)
    .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface);
  const decodeOne = (candidate: ChainEventLogRow) => decoders.decodeContextGraphKaRegistrations([candidate])[0];

  it('decodes every canonical row exactly as parseLog does', () => {
    const random = prng(7);
    const uint256 = (): bigint => {
      const roll = random();
      if (roll < 0.05) return 0n;
      if (roll < 0.1) return (1n << 256n) - 1n;
      if (roll < 0.4) return BigInt(Math.floor(random() * 1_000_000));
      let value = 0n;
      for (let limb = 0; limb < 8; limb += 1) value = (value << 32n) | BigInt(Math.floor(random() * 2 ** 32));
      return value;
    };
    for (let index = 0; index < 2_000; index += 1) {
      const contextGraphId = uint256();
      const kaId = index % 4 === 0 ? (uint256() << 96n) % (1n << 256n) : uint256();
      const encoded = cgInterface.encodeEventLog(
        cgInterface.getEvent('KnowledgeAssetRegisteredToContextGraph')!,
        [contextGraphId, kaId],
      );
      const canonical = row(encoded.topics.map((topic) => topic.toLowerCase()), encoded.data, index);
      expect(canonical.topics).toEqual([TOPIC0, word(contextGraphId), word(kaId)]);
      expect(decodeOne(canonical)).toEqual(parseLogDecode(cgInterface, canonical));
      expect(decodeOne(canonical)).toMatchObject({ contextGraphId, kaId });
    }
  });

  it('leaves every other shape to parseLog, results and errors alike', () => {
    // Ids with hex letters in them, so case can differ.
    const cg = word(0xabcdefn);
    const ka = word(0xfeedn);
    const cases: ChainEventLogRow[] = [
      row([TOPIC0, cg.toUpperCase().replace('0X', '0x'), ka]), // mixed-case topic
      row([TOPIC0.toUpperCase().replace('0X', '0x'), cg, ka]), // mixed-case topic0
      row([TOPIC0, cg, ka, word(1n)]), // an extra topic
      row([TOPIC0, cg, ka], `0x${'00'.repeat(32)}`), // data where the event has none
      row([TOPIC0, cg]), // a missing topic
      row([TOPIC0, `0x${'7'.repeat(63)}`, ka]), // a short topic word
      row([TOPIC0, cg, `0x${'zz'.repeat(32)}`]), // not hex
    ];
    for (const candidate of cases) {
      expect(outcome(() => decodeOne(candidate)), candidate.topics.join(','))
        .toEqual(outcome(() => parseLogDecode(cgInterface, candidate)));
    }
    // The canonical case agrees too, and the malformed ones really do fail.
    expect(outcome(() => decodeOne(row([TOPIC0, cg, ka]))))
      .toEqual(outcome(() => parseLogDecode(cgInterface, row([TOPIC0, cg, ka]))));
    expect(outcome(() => decodeOne(cases[4]!))).toHaveProperty('error');
  });

  it('keeps parseLog for an ABI whose registration event is shaped differently', () => {
    // Same signature, so the same topic0, but the names swapped: `parseLog`
    // reads `contextGraphId` from topic2. A fast path that assumed the shipped
    // ABI's order would bind every KA to the wrong graph.
    const swapped = new ethers.Interface([
      'event KnowledgeAssetRegisteredToContextGraph(uint256 indexed kaId, uint256 indexed contextGraphId)',
    ]);
    expect(swapped.getEvent('KnowledgeAssetRegisteredToContextGraph')!.topicHash.toLowerCase()).toBe(TOPIC0);
    const swappedDecoders = new ChainEventDecoderRegistry()
      .registerContextGraphKnowledgeAssets(CG_STORAGE, swapped);
    const canonical = row([TOPIC0, word(7n), word(4242n)]);
    expect(swappedDecoders.decodeContextGraphKaRegistrations([canonical])[0])
      .toMatchObject({ contextGraphId: 4242n, kaId: 7n });
    expect(swappedDecoders.decodeContextGraphKaRegistrations([canonical])[0])
      .toEqual(parseLogDecode(swapped, canonical));
  });
});
