// Behavioral regression pin for the RESPONDER half of the #1509 SWM merkle
// exclusion unification (the 2026-07-07 Gnosis mainnet MERKLE_MISMATCH_IN_SWM
// incident).
//
// #1509 made the publisher seal and the core responder recompute share ONE
// exclusion filter — `isSwmMerkleExcludedQuad` (dkg-core trust.ts): trust-level
// annotations and workspaceOwner bookkeeping are SWM-ingestion artifacts, not
// author payload, so hashing them into the flat KC root on one side but not
// the other declines every affected ACK. The helper itself is unit-tested,
// but the #1509 review found NOTHING pinned the responder boundary: deleting
// the `isSwmMerkleExcludedQuad` filter from either branch of
// `StorageACKHandler.loadSWMQuads` (read-both vs per-root-entity) passed the
// entire suite.
//
// These tests seed the incident shape — bookkeeping quads stamped INTO the SWM
// DATA graph, not `_shared_memory_meta` (whose graph-layout exclusion is pinned
// separately in swm-seal-recompute-parity.test.ts) — and drive the real
// responder entry point: a PublishIntent with no stagingQuads, which takes the
// SWM fallback through `loadSWMQuads`. The signed ACK must carry the
// AUTHOR-ONLY root. Drop the filter from either branch and the recompute
// hashes the bookkeeping quads → MERKLE_MISMATCH_IN_SWM decline → the
// corresponding test fails (mutation-verified for both branches).

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  encodePublishIntent,
  decodeStorageACK,
  isStorageACKDecline,
  TRUST_LEVEL_PREDICATE,
  LEGACY_TRUST_LEVEL_PREDICATE,
  WORKSPACE_OWNER_PREDICATE,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const CONTEXT_GRAPH_ID = '42';
const SWM_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory`;

const coreWallet = ethers.Wallet.createRandom();
const fakePeerId = { toString: () => 'requester-peer' };

const q = (subject: string, predicate: string, object: string): Quad =>
  ({ subject, predicate, object, graph: SWM_GRAPH_URI });

// The author's payload — what the publisher sealed the KC root over.
const authorQuads: Quad[] = [
  q('urn:entity:1', 'http://schema.org/name', '"Entity One"'),
  q('urn:entity:1', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Thing'),
  q('urn:entity:2', 'http://schema.org/name', '"Entity Two"'),
];

// SWM-ingestion bookkeeping stamped into the DATA graph on the SAME root
// subjects (the incident shape), covering all three excluded predicates:
// modern + legacy trust-level, and workspaceOwner. Subjects match the
// declared rootEntities so the per-root-entity CONSTRUCT selects them too —
// otherwise that branch's filter would be vacuous here.
const bookkeepingQuads: Quad[] = [
  q('urn:entity:1', TRUST_LEVEL_PREDICATE, '"3"^^<http://www.w3.org/2001/XMLSchema#integer>'),
  q('urn:entity:1', WORKSPACE_OWNER_PREDICATE, 'did:dkg:agent:0xowner'),
  q('urn:entity:2', LEGACY_TRUST_LEVEL_PREDICATE, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'),
];

const authorOnlyRoot = computeFlatKCRoot(authorQuads, []);
const authorOnlyLeafCount = computeFlatKCMerkleLeafCountV10(authorQuads, []);

async function seededHandler(): Promise<StorageACKHandler> {
  const store = new OxigraphStore();
  await store.insert([...authorQuads, ...bookkeepingQuads]);
  const config: StorageACKHandlerConfig = {
    nodeRole: 'core',
    nodeIdentityId: 42n,
    signerWallet: coreWallet,
    contextGraphSharedMemoryUri: (cgId: string) =>
      `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: TEST_CHAIN_ID,
    kav10Address: TEST_KAV10_ADDR,
  };
  const eventBus = { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };
  return new StorageACKHandler(store as any, config, eventBus as any);
}

/**
 * Drive the SWM-fallback publish path (no stagingQuads) against a store whose
 * data graph holds author quads + bookkeeping quads, with the intent sealed
 * over the AUTHOR-ONLY payload. A signed ACK carrying the author-only root
 * proves `loadSWMQuads` applied `isSwmMerkleExcludedQuad`; a dropped filter
 * surfaces as a MERKLE_MISMATCH_IN_SWM decline and fails here.
 */
async function expectAuthorOnlyAck(rootEntities: string[]): Promise<void> {
  const handler = await seededHandler();
  const intent = encodePublishIntent({
    merkleRoot: authorOnlyRoot,
    contextGraphId: CONTEXT_GRAPH_ID,
    publisherPeerId: 'pub-0',
    publicByteSize: 4096,
    isPrivate: false,
    kaCount: 1,
    rootEntities,
    merkleLeafCount: authorOnlyLeafCount,
    // NO stagingQuads → the handler takes the SWM fallback → loadSWMQuads.
  });

  const response = await handler.handler(intent, fakePeerId);
  const ack = decodeStorageACK(response);

  if (isStorageACKDecline(ack)) {
    throw new Error(
      `expected a signed ACK over the author-only root, got decline ` +
      `${ack.declineCode}: ${ack.declineMessage}`,
    );
  }
  const root = ack.merkleRoot instanceof Uint8Array
    ? ack.merkleRoot
    : new Uint8Array(ack.merkleRoot);
  expect(ethers.hexlify(root)).toBe(ethers.hexlify(authorOnlyRoot));
}

describe('responder SWM merkle exclusion at the loadSWMQuads boundary (#1509)', () => {
  it('discriminating power: hashing the bookkeeping quads WOULD change the root', () => {
    // Sanity guard for the two tests below: if the bookkeeping quads did not
    // move the root, a dropped filter could never be detected here.
    const pollutedRoot = computeFlatKCRoot([...authorQuads, ...bookkeepingQuads], []);
    expect(ethers.hexlify(pollutedRoot)).not.toBe(ethers.hexlify(authorOnlyRoot));
  });

  it('read-both branch (rootEntities = []) strips bookkeeping before the recompute', async () => {
    await expectAuthorOnlyAck([]);
  });

  it('per-root-entity branch strips bookkeeping before the recompute', async () => {
    await expectAuthorOnlyAck(['urn:entity:1', 'urn:entity:2']);
  });
});
