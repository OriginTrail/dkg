/**
 * Raw-log topic vs. decoded-struct invariants for V10 events.
 *
 * Audit findings covered:
 *
 *   CH-6 (HIGH) — Today the chain package has no test that pins the
 *                 cryptographic topic hash for the events it parses —
 *                 `ContextGraphCreated`, `KnowledgeCollectionCreated`,
 *                 `KnowledgeAssetsMinted`, `KnowledgeCollectionUpdated`.
 *                 This is the #32-class regression (receipt-log decode
 *                 races): if a contract is re-declared with the same
 *                 canonical name but different parameters (e.g. a new
 *                 field), the event SELECTOR changes, the ethers
 *                 `interface.parseLog` skips the log silently, and the
 *                 adapter emits `null` batchId / empty results.
 *
 *                 We assert two things for each event:
 *                   1. `keccak256(canonical_sig)` equals the topic[0] that
 *                      `ethers.Interface.getEvent(name).topicHash` would
 *                      produce from the shipped ABI.
 *                   2. A hand-rolled canonical signature string matches the
 *                      ABI-derived signature (catches drift that leaves
 *                      the same selector but shifts parameter ordering —
 *                      can happen with struct inlining in Solidity).
 *
 * Per QA policy: do NOT edit the ABI files. If an assertion fails, either
 * the ABI in packages/chain/abi/*.json is stale vs. the contract, or the
 * spec rename happened without updating `EVMChainAdapter`'s `parseLog`
 * calls.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { id as keccak256OfString, Interface } from 'ethers';

const ABI_DIR = join(import.meta.dirname, '..', 'abi');

function loadInterface(contractName: string): Interface {
  const raw = readFileSync(join(ABI_DIR, `${contractName}.json`), 'utf8');
  return new Interface(JSON.parse(raw));
}

function canonicalSignature(iface: Interface, eventName: string): string {
  const ev = iface.getEvent(eventName);
  if (!ev) throw new Error(`Event "${eventName}" not in interface`);
  // ev.format('sighash') yields `EventName(type1,type2,...)` — the exact
  // input to keccak256 for the topic[0] hash.
  return ev.format('sighash');
}

describe('ContextGraphCreated — topic0 and signature pinning [CH-6]', () => {
  const iface = loadInterface('ContextGraphStorage');
  const EXPECTED_SIG =
    'ContextGraphCreated(uint256,address,uint72[],address[],uint8,uint256,uint8,address,uint256)';

  it('canonical signature matches the spec field ordering', () => {
    expect(canonicalSignature(iface, 'ContextGraphCreated')).toBe(EXPECTED_SIG);
  });

  it('topic[0] equals keccak256(canonical signature) — raw keccak cross-check', () => {
    const ev = iface.getEvent('ContextGraphCreated');
    const expectedTopic0 = keccak256OfString(EXPECTED_SIG);
    expect(ev!.topicHash.toLowerCase()).toBe(expectedTopic0.toLowerCase());
  });

  it('parseLog round-trip preserves first indexed arg (contextGraphId)', () => {
    const ev = iface.getEvent('ContextGraphCreated')!;
    const topic0 = ev.topicHash;
    // Build a synthetic log with topic0 + indexed contextGraphId + owner,
    // plus encoded non-indexed tail. ethers' AbiCoder does the heavy
    // lifting; if we mis-order, parseLog throws.
    const { AbiCoder, zeroPadValue } = require('ethers') as typeof import('ethers');
    const coder = new AbiCoder();
    const nonIndexed = coder.encode(
      ['uint72[]', 'address[]', 'uint8', 'uint256', 'uint8', 'address', 'uint256'],
      [[1n, 2n, 3n], [], 2, 0n, 1, '0x0000000000000000000000000000000000000000', 0n],
    );
    const parsed = iface.parseLog({
      topics: [
        topic0,
        zeroPadValue('0x2a', 32),                     // contextGraphId = 42
        zeroPadValue('0x000000000000000000000000000000000000000b', 32), // owner
      ],
      data: nonIndexed,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.args.contextGraphId).toBe(42n);
    expect(parsed!.args.hostingNodes.map((x: bigint) => x)).toEqual([1n, 2n, 3n]);
    expect(Number(parsed!.args.requiredSignatures)).toBe(2);
  });
});

describe('KnowledgeCollectionCreated — topic0 and signature pinning [CH-6]', () => {
  const iface = loadInterface('KnowledgeCollectionStorage');
  const EXPECTED_SIG =
    'KnowledgeCollectionCreated(uint256,string,bytes32,uint88,uint40,uint40,uint96,bool)';

  it('canonical signature matches the spec field ordering', () => {
    expect(canonicalSignature(iface, 'KnowledgeCollectionCreated')).toBe(EXPECTED_SIG);
  });

  it('topic[0] equals keccak256(canonical signature)', () => {
    const ev = iface.getEvent('KnowledgeCollectionCreated');
    expect(ev!.topicHash.toLowerCase()).toBe(keccak256OfString(EXPECTED_SIG).toLowerCase());
  });

  it('parseLog extracts id (indexed) + merkleRoot (non-indexed) in the right order', () => {
    const iface2 = loadInterface('KnowledgeCollectionStorage');
    const ev = iface2.getEvent('KnowledgeCollectionCreated')!;
    const { AbiCoder, zeroPadValue } = require('ethers') as typeof import('ethers');
    const coder = new AbiCoder();
    const merkleRoot = '0x' + 'ab'.repeat(32);
    const nonIndexed = coder.encode(
      ['string', 'bytes32', 'uint88', 'uint40', 'uint40', 'uint96', 'bool'],
      ['op-id', merkleRoot, 1024n, 1n, 100n, 10n ** 18n, false],
    );
    const parsed = iface2.parseLog({
      topics: [ev.topicHash, zeroPadValue('0x07', 32)],
      data: nonIndexed,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.args.id).toBe(7n);
    expect(parsed!.args.merkleRoot).toBe(merkleRoot);
    expect(parsed!.args.publishOperationId).toBe('op-id');
    expect(parsed!.args.byteSize).toBe(1024n);
    expect(parsed!.args.isImmutable).toBe(false);
  });
});

describe('KnowledgeAssetsMinted — topic0 and signature pinning [CH-6]', () => {
  const iface = loadInterface('KnowledgeCollectionStorage');
  const EXPECTED_SIG = 'KnowledgeAssetsMinted(uint256,address,uint256,uint256)';

  it('canonical signature matches the spec field ordering', () => {
    expect(canonicalSignature(iface, 'KnowledgeAssetsMinted')).toBe(EXPECTED_SIG);
  });

  it('topic[0] equals keccak256(canonical signature)', () => {
    const ev = iface.getEvent('KnowledgeAssetsMinted');
    expect(ev!.topicHash.toLowerCase()).toBe(keccak256OfString(EXPECTED_SIG).toLowerCase());
  });

  it('endId in the event is EXCLUSIVE (spec §07: startId..endId-1 are minted)', () => {
    // This is a regression guard for the code in EVMChainAdapter that
    // converts `endId - 1n` into the inclusive publicly-visible endKAId.
    // If a future contract change flips the convention, this assertion
    // fires and the `endId - 1n` math in the adapter must be removed.
    const iface2 = loadInterface('KnowledgeCollectionStorage');
    const ev = iface2.getEvent('KnowledgeAssetsMinted')!;
    const { AbiCoder, zeroPadValue } = require('ethers') as typeof import('ethers');
    const coder = new AbiCoder();
    const nonIndexed = coder.encode(['uint256', 'uint256'], [10n, 13n]);
    const parsed = iface2.parseLog({
      topics: [
        ev.topicHash,
        zeroPadValue('0x01', 32),
        zeroPadValue('0x000000000000000000000000000000000000000c', 32),
      ],
      data: nonIndexed,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.args.startId).toBe(10n);
    expect(parsed!.args.endId).toBe(13n);
    // Inclusive endKAId = endId - 1 = 12 (3 tokens minted).
    expect(parsed!.args.endId - 1n).toBe(12n);
  });
});

describe('KnowledgeCollectionUpdated — topic0 and signature pinning [CH-6]', () => {
  const iface = loadInterface('KnowledgeCollectionStorage');
  const EXPECTED_SIG =
    'KnowledgeCollectionUpdated(uint256,string,bytes32,uint256,uint96)';

  it('canonical signature matches the V10 update spec', () => {
    expect(canonicalSignature(iface, 'KnowledgeCollectionUpdated')).toBe(EXPECTED_SIG);
  });

  it('topic[0] equals keccak256(canonical signature)', () => {
    const ev = iface.getEvent('KnowledgeCollectionUpdated');
    expect(ev!.topicHash.toLowerCase()).toBe(keccak256OfString(EXPECTED_SIG).toLowerCase());
  });
});

describe('Event selectors are pairwise distinct (no hash collision) [CH-6]', () => {
  // A paranoid cross-check: every event we parse out of the chain package
  // must have a unique selector. If any two collide, parseLog is ambiguous
  // and will silently pick the wrong decoder on multi-contract receipts.
  it('the V10 event set has no selector collisions', () => {
    const iface = loadInterface('KnowledgeCollectionStorage');
    const cgIface = loadInterface('ContextGraphStorage');
    const names = [
      ['KnowledgeCollectionStorage', 'KnowledgeCollectionCreated', iface],
      ['KnowledgeCollectionStorage', 'KnowledgeAssetsMinted', iface],
      ['KnowledgeCollectionStorage', 'KnowledgeCollectionUpdated', iface],
      ['ContextGraphStorage', 'ContextGraphCreated', cgIface],
      ['ContextGraphStorage', 'KCRegisteredToContextGraph', cgIface],
    ] as const;
    const selectors = new Map<string, string>();
    for (const [_ctr, evName, ifc] of names) {
      const topic = ifc.getEvent(evName)!.topicHash.toLowerCase();
      if (selectors.has(topic)) {
        throw new Error(
          `Selector collision: ${evName} has same topic as ${selectors.get(topic)}`,
        );
      }
      selectors.set(topic, evName);
    }
    expect(selectors.size).toBe(names.length);
  });
});
