import { describe, expect, it } from 'vitest';
import type { NetworkIdV1 } from '../src/index.js';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  LEGACY_ROOT_CONTENT_SCOPE_VERSION,
  LegacyKnowledgeAssetReadOnlyError,
  MAX_KNOWLEDGE_ASSET_NUMBER,
  MemoryLayer,
  assertCanonicalDeterministicUalV1,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  parseDeterministicKnowledgeAssetUal,
  resolveKnowledgeAssetReadScope,
  resolveKnowledgeAssetWriteScope,
  unpackDeterministicRootlessKnowledgeAssetId,
} from '../src/index.js';

const UAL = 'did:dkg:base:8453/0x70997970C51812dc3A010C7d01b50e0d17dc79C8/0007';
const CANONICAL_UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const NETWORK_ID = 'base:8453' as NetworkIdV1;

describe('KA content scope', () => {
  it('canonicalizes a deterministic UAL and assertion version', () => {
    expect(parseDeterministicKnowledgeAssetUal(UAL)).toEqual({
      ual: CANONICAL_UAL,
      chainId: 'base:8453',
      agentAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      kaNumber: '7',
    });

    expect(createGraphKnowledgeAssetScope(UAL, '0002')).toMatchObject({
      ual: CANONICAL_UAL,
      assertionVersion: '2',
      access: 'read-write',
    });
  });

  it('asserts one canonical deterministic UAL and returns every identity part', () => {
    expect(assertCanonicalDeterministicUalV1(CANONICAL_UAL)).toEqual({
      ual: CANONICAL_UAL,
      chainId: 'base:8453',
      agentAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      kaNumber: '7',
    });
    expect(() => assertCanonicalDeterministicUalV1(UAL)).toThrow(/canonical form/);
  });

  it('rejects KA numbers outside the uint96 on-chain identity domain', () => {
    const tooLarge = 1n << 96n;
    const ual = `did:dkg:base:8453/0x70997970c51812dc3a010C7d01b50e0d17dc79C8/${tooLarge}`;

    expect(() => parseDeterministicKnowledgeAssetUal(ual))
      .toThrow(/packed uint96 identity domain/);
  });

  it('canonically unpacks rootless ids and rejects legacy or out-of-range ids', () => {
    const author = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
    const packed = (author << 96n) | 7n;
    expect(unpackDeterministicRootlessKnowledgeAssetId(NETWORK_ID, packed)).toEqual({
      kaId: packed.toString(),
      ual: CANONICAL_UAL,
      chainId: 'base:8453',
      agentAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      kaNumber: '7',
    });
    expect(() => unpackDeterministicRootlessKnowledgeAssetId(NETWORK_ID, 7n))
      .toThrow(/packed author/);
    expect(() => unpackDeterministicRootlessKnowledgeAssetId(NETWORK_ID, 0n))
      .toThrow(/nonzero uint256/);
    expect(() => unpackDeterministicRootlessKnowledgeAssetId(NETWORK_ID, 1n << 256n))
      .toThrow(/nonzero uint256/);
    expect(() => unpackDeterministicRootlessKnowledgeAssetId('base/8453' as never, packed))
      .toThrow(/networkId grammar/);
  });

  it('derives one stable per-KA graph while assertion version remains explicit', () => {
    const v1 = createGraphKnowledgeAssetScope(UAL, 1);
    const v2 = createGraphKnowledgeAssetScope(UAL, 2);
    expect(knowledgeAssetLayerGraphUri('private-cg', MemoryLayer.SharedWorkingMemory, v1))
      .toBe(
        'did:dkg:context-graph:private-cg/_shared_memory/' +
        '0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7',
      );
    expect(knowledgeAssetLayerGraphUri('private-cg', MemoryLayer.SharedWorkingMemory, v2))
      .toBe(knowledgeAssetLayerGraphUri('private-cg', MemoryLayer.SharedWorkingMemory, v1));
    expect(v1.assertionVersion).not.toBe(v2.assertionVersion);
  });

  it('resolves graph scope for reads and writes without exposing roots', () => {
    const input = {
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      rootEntities: ['urn:legacy:must-be-ignored'],
    };
    const readScope = resolveKnowledgeAssetReadScope(input);
    const writeScope = resolveKnowledgeAssetWriteScope(input);
    expect(readScope).toEqual(writeScope);
    expect(readScope.kind).toBe('ka-graph');
    expect('rootEntities' in readScope).toBe(false);
  });

  it('allows existing V10 roots through reads but rejects every mutation', () => {
    for (const contentScopeVersion of [undefined, LEGACY_ROOT_CONTENT_SCOPE_VERSION]) {
      const input = {
        contentScopeVersion,
        rootEntities: ['urn:entity:a', 'urn:entity:a', 'urn:entity:b'],
      };
      expect(resolveKnowledgeAssetReadScope(input)).toEqual({
        version: LEGACY_ROOT_CONTENT_SCOPE_VERSION,
        kind: 'legacy-roots',
        access: 'read-only',
        rootEntities: ['urn:entity:a', 'urn:entity:b'],
      });
      expect(() => resolveKnowledgeAssetWriteScope(input))
        .toThrow(LegacyKnowledgeAssetReadOnlyError);
    }
  });

  it('admits only KA numbers that round-trip through the packed uint96 kaId', () => {
    const prefix = 'did:dkg:base:8453/0x0000000000000000000000000000000000000002/';
    const maxUal = `${prefix}${MAX_KNOWLEDGE_ASSET_NUMBER}`;
    expect(parseDeterministicKnowledgeAssetUal(maxUal)).toMatchObject({
      ual: maxUal,
      kaNumber: MAX_KNOWLEDGE_ASSET_NUMBER.toString(),
    });
    expect(parseDeterministicKnowledgeAssetUal(`${prefix}0`).kaNumber).toBe('0');

    // 2^96 packs to (author+1, number 0): author 0x…02 with number 2^96 would
    // collide with author 0x…03 / number 0. The parser must reject the spill.
    const overflow = MAX_KNOWLEDGE_ASSET_NUMBER + 1n;
    expect(() => parseDeterministicKnowledgeAssetUal(`${prefix}${overflow}`))
      .toThrow(/packed uint96 identity domain/);
    expect(() => parseDeterministicKnowledgeAssetUal(`${prefix}${overflow + 5n}`))
      .toThrow(/packed uint96 identity domain/);
    // Negative numbers never match the UAL grammar.
    expect(() => parseDeterministicKnowledgeAssetUal(`${prefix}-1`))
      .toThrow(/must match/);
    expect(() => createGraphKnowledgeAssetScope(`${prefix}${overflow}`, 1))
      .toThrow(/packed uint96 identity domain/);
  });

  it('fails closed on missing identity/version, invalid roots, and future versions', () => {
    expect(() => resolveKnowledgeAssetReadScope({
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      assertionVersion: 1,
    })).toThrow(/Invalid graph-scoped KA UAL/);
    expect(() => resolveKnowledgeAssetReadScope({
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
    })).toThrow(/requires assertionVersion/);
    expect(() => createGraphKnowledgeAssetScope(UAL, 0))
      .toThrow(/must be at least 1/);
    expect(() => resolveKnowledgeAssetReadScope({ rootEntities: [] }))
      .toThrow(/at least one root entity/);
    expect(() => resolveKnowledgeAssetReadScope({ rootEntities: ['not an iri'] }))
      .toThrow(/Invalid legacy root entity IRI/);
    expect(() => resolveKnowledgeAssetReadScope({
      contentScopeVersion: 3,
      kaUal: UAL,
      assertionVersion: 1,
    })).toThrow(/Unsupported KA content scope version/);
  });
});
