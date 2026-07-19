import { describe, it, expect } from 'vitest';
import {
  contextGraphSharedMemoryTopic,
  contextGraphFinalizationTopic,
  contextGraphAppTopic,
  contextGraphDataUri,
  contextGraphSessionsTopic,
  contextGraphPublishTopic,
  contextGraphWorkspaceTopic,
  contextGraphAssertionUri,
  parseContextGraphAssertionUri,
  DHT_PROTOCOL,
  validateContextGraphId,
  validateNewContextGraphId,
  validateSubGraphName,
  validateAssertionName,
  deriveCuratorDidFromCgId,
  dhtProtocolForNetwork,
  logicalTopicFromWireTopic,
  networkNamespaceSegment,
  wireTopicForNetwork,
} from '../src/constants.js';
import { createOperationContext } from '../src/logger.js';

describe('parseContextGraphAssertionUri (inverse of contextGraphAssertionUri)', () => {
  const ADDR = '0xA32f1cc125401B55911678847426759094055B2d';
  // Wallet-scoped context graph IDs may contain '/' (validateContextGraphId allows it).
  const SLASH_CG = '0x1111111111111111111111111111111111111111/project';

  it('round-trips the no-subgraph coordinate (scope = contextGraphId)', () => {
    const uri = contextGraphAssertionUri('construction', ADDR, 'justTriplets');
    expect(parseContextGraphAssertionUri(uri)).toEqual({
      scope: 'construction',
      agentAddress: ADDR,
      name: 'justTriplets',
    });
  });

  it('round-trips the sub-graph coordinate (scope = contextGraphId/subGraphName)', () => {
    const uri = contextGraphAssertionUri('construction', ADDR, 'justTriplets', 'wing-a');
    expect(parseContextGraphAssertionUri(uri)).toEqual({
      scope: 'construction/wing-a',
      agentAddress: ADDR,
      name: 'justTriplets',
    });
  });

  it('preserves a slash-containing contextGraphId (GH#1778 review) — no subgraph', () => {
    const uri = contextGraphAssertionUri(SLASH_CG, ADDR, 'asset');
    // The whole cg id (incl. its slash) is the scope; it is NOT mis-split into a subgraph.
    expect(parseContextGraphAssertionUri(uri)).toEqual({
      scope: SLASH_CG,
      agentAddress: ADDR,
      name: 'asset',
    });
  });

  it('preserves a slash-containing contextGraphId with a subGraphName', () => {
    const uri = contextGraphAssertionUri(SLASH_CG, ADDR, 'asset', 'wing-a');
    expect(parseContextGraphAssertionUri(uri)).toEqual({
      scope: `${SLASH_CG}/wing-a`,
      agentAddress: ADDR,
      name: 'asset',
    });
  });

  it('anchors on the rightmost assertion coordinate even when the scope contains one', () => {
    const trickyCg = `weird/assertion/${ADDR}/inner`;
    const uri = contextGraphAssertionUri(trickyCg, ADDR, 'asset');
    expect(parseContextGraphAssertionUri(uri)).toEqual({
      scope: trickyCg,
      agentAddress: ADDR,
      name: 'asset',
    });
  });

  it('returns undefined for non-assertion, malformed, or non-0x-author subjects', () => {
    expect(parseContextGraphAssertionUri('did:dkg:context-graph:construction/_meta')).toBeUndefined();
    expect(parseContextGraphAssertionUri(`did:dkg:context-graph:construction/_shared_memory/${ADDR}/7`)).toBeUndefined();
    expect(parseContextGraphAssertionUri('did:dkg:gnosis:100/0xabc/7')).toBeUndefined();
    expect(parseContextGraphAssertionUri('urn:dkg:assertion:construction:0xabc:name')).toBeUndefined();
    // author segment is not a 0x40 address
    expect(parseContextGraphAssertionUri('did:dkg:context-graph:construction/assertion/notanaddr/asset')).toBeUndefined();
  });
});

describe('context graph topic helpers (V10)', () => {
  it('contextGraphFinalizationTopic matches deprecated contextGraphPublishTopic', () => {
    expect(contextGraphPublishTopic('testing')).toBe(contextGraphFinalizationTopic('testing'));
    expect(contextGraphPublishTopic('testing')).toBe('dkg/context-graph/testing/finalization');
  });

  it('contextGraphSharedMemoryTopic matches deprecated contextGraphWorkspaceTopic', () => {
    expect(contextGraphWorkspaceTopic('testing')).toBe(contextGraphSharedMemoryTopic('testing'));
    expect(contextGraphSharedMemoryTopic('testing')).toBe('dkg/context-graph/testing/shared-memory');
  });

  it('contextGraphAppTopic returns V10 app topic', () => {
    expect(contextGraphAppTopic('testing')).toBe('dkg/context-graph/testing/app');
    expect(contextGraphAppTopic('agents')).toBe('dkg/context-graph/agents/app');
  });

  it('contextGraphDataUri returns V10 data URI', () => {
    expect(contextGraphDataUri('agents')).toBe('did:dkg:context-graph:agents');
  });

  it('contextGraphSessionsTopic returns V10 sessions topic', () => {
    expect(contextGraphSessionsTopic('testing')).toBe('dkg/context-graph/testing/sessions');
  });

  it('handles empty string context graph ID (V10 format)', () => {
    expect(contextGraphFinalizationTopic('')).toBe('dkg/context-graph//finalization');
    expect(contextGraphDataUri('')).toBe('did:dkg:context-graph:');
  });

  it('preserves context graph IDs with special characters (V10 format)', () => {
    expect(contextGraphFinalizationTopic('my-context-graph')).toBe(
      'dkg/context-graph/my-context-graph/finalization',
    );
    expect(contextGraphFinalizationTopic('cg_v2')).toBe('dkg/context-graph/cg_v2/finalization');
  });

  it('does not sanitize slashes in context graph IDs (caller responsibility)', () => {
    const result = contextGraphFinalizationTopic('a/b');
    expect(result).toBe('dkg/context-graph/a/b/finalization');
  });

  it('deprecated contextGraphPublishTopic delegates to contextGraphFinalizationTopic', () => {
    expect(contextGraphPublishTopic('my-contextGraph')).toBe(contextGraphFinalizationTopic('my-contextGraph'));
    expect(contextGraphPublishTopic('')).toBe(contextGraphFinalizationTopic(''));
    expect(contextGraphPublishTopic('a/b')).toBe(contextGraphFinalizationTopic('a/b'));
  });
});

describe('network namespace helpers', () => {
  it('keeps the legacy DHT protocol when no network identity is supplied', () => {
    expect(dhtProtocolForNetwork()).toBe(DHT_PROTOCOL);
  });

  it('derives distinct DHT protocols for distinct networks', () => {
    expect(dhtProtocolForNetwork('base-testnet')).toBe('/dkg/base-testnet/kad/1.0.0');
    expect(dhtProtocolForNetwork('base-mainnet')).toBe('/dkg/base-mainnet/kad/1.0.0');
  });

  it('derives distinct DHT protocols for the same network id on different chains', () => {
    expect(dhtProtocolForNetwork('shared-genesis', 'base:84532')).toBe('/dkg/shared-genesis.base:84532/kad/1.0.0');
    expect(dhtProtocolForNetwork('shared-genesis', 'base:8453')).toBe('/dkg/shared-genesis.base:8453/kad/1.0.0');
  });

  it('maps logical DKG topics into and out of network-scoped wire topics', () => {
    const logical = contextGraphFinalizationTopic('agents');
    const wire = wireTopicForNetwork('base-testnet', logical);
    expect(wire).toBe('dkg/network/base-testnet/context-graph/agents/finalization');
    expect(logicalTopicFromWireTopic('base-testnet', wire)).toBe(logical);
    expect(logicalTopicFromWireTopic('base-mainnet', wire)).toBeNull();
  });

  it('maps logical DKG topics into chain-scoped wire topics', () => {
    const logical = contextGraphFinalizationTopic('agents');
    const baseSepoliaWire = wireTopicForNetwork('shared-genesis', logical, 'base:84532');
    const baseMainnetWire = wireTopicForNetwork('shared-genesis', logical, 'base:8453');

    expect(baseSepoliaWire).toBe('dkg/network/shared-genesis.base:84532/context-graph/agents/finalization');
    expect(baseMainnetWire).toBe('dkg/network/shared-genesis.base:8453/context-graph/agents/finalization');
    expect(logicalTopicFromWireTopic('shared-genesis', baseSepoliaWire, 'base:84532')).toBe(logical);
    expect(logicalTopicFromWireTopic('shared-genesis', baseSepoliaWire, 'base:8453')).toBeNull();
  });

  it('round-trips non-DKG topics without colliding with DKG topic suffixes', () => {
    const wire = wireTopicForNetwork('network-a', 'custom/topic');
    expect(wire).toBe('dkg/network/network-a/topic/custom/topic');
    expect(logicalTopicFromWireTopic('network-a', wire)).toBe('custom/topic');
  });

  it('rejects unsafe network namespace segments', () => {
    expect(() => networkNamespaceSegment('base/testnet')).toThrow(/Invalid DKG network namespace/);
    expect(() => networkNamespaceSegment('base-testnet', 'bad chain')).toThrow(/Invalid DKG network namespace/);
    expect(() => dhtProtocolForNetwork('base testnet')).toThrow(/Invalid DKG network namespace/);
  });
});

describe('createOperationContext', () => {
  it('generates a unique operationId', () => {
    const ctx = createOperationContext('publish');
    expect(ctx.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.operationName).toBe('publish');
    expect(ctx.sourceOperationId).toBeUndefined();
  });

  it('accepts a sourceOperationId for cross-node correlation', () => {
    const sourceId = '550e8400-e29b-41d4-a716-446655440000';
    const ctx = createOperationContext('gossip', sourceId);
    expect(ctx.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.operationId).not.toBe(sourceId);
    expect(ctx.sourceOperationId).toBe(sourceId);
  });
});

describe('validateContextGraphId', () => {
  it('accepts valid context graph IDs', () => {
    expect(validateContextGraphId('my-context-graph').valid).toBe(true);
    expect(validateContextGraphId('agent-skills').valid).toBe(true);
    expect(validateContextGraphId('cg_v2').valid).toBe(true);
  });

  it('rejects empty IDs', () => {
    expect(validateContextGraphId('').valid).toBe(false);
  });

  it('rejects disallowed characters (whitelist: alphanumeric, _, :, /, ., @, -)', () => {
    expect(validateContextGraphId('foo<bar').valid).toBe(false);
    expect(validateContextGraphId('foo>bar').valid).toBe(false);
    expect(validateContextGraphId('foo bar').valid).toBe(false);
    expect(validateContextGraphId('foo"bar').valid).toBe(false);
    expect(validateContextGraphId('foo{bar').valid).toBe(false);
    expect(validateContextGraphId('foo?bar').valid).toBe(false);
    expect(validateContextGraphId('foo#bar').valid).toBe(false);
  });

  it('accepts URNs, DIDs, and slug-like identifiers', () => {
    expect(validateContextGraphId('did:dkg:test').valid).toBe(true);
    expect(validateContextGraphId('urn:uuid:12345').valid).toBe(true);
    expect(validateContextGraphId('my-graph_v2').valid).toBe(true);
    expect(validateContextGraphId('user@domain').valid).toBe(true);
  });

  it('reserves structural partition segments for new IDs without breaking legacy reads', () => {
    for (const id of [
      'victim/_meta',
      'victim/_private',
      'victim/_shared_memory',
      'victim/_future-partition',
    ]) {
      expect(validateContextGraphId(id)).toEqual({ valid: true });
      expect(validateNewContextGraphId(id)).toMatchObject({ valid: false });
    }
  });

  it('rejects IDs exceeding 256 chars', () => {
    expect(validateContextGraphId('a'.repeat(257)).valid).toBe(false);
    expect(validateContextGraphId('a'.repeat(256)).valid).toBe(true);
  });
});

describe('validateAssertionName', () => {
  it('accepts valid assertion names', () => {
    expect(validateAssertionName('my-assertion').valid).toBe(true);
    expect(validateAssertionName('draft-001').valid).toBe(true);
  });

  it('rejects empty names', () => {
    expect(validateAssertionName('').valid).toBe(false);
  });

  it('rejects names with slashes', () => {
    expect(validateAssertionName('a/b').valid).toBe(false);
  });

  it('rejects IRI-unsafe characters', () => {
    expect(validateAssertionName('a<b').valid).toBe(false);
    expect(validateAssertionName('a b').valid).toBe(false);
  });

  it('rejects names exceeding 256 chars', () => {
    expect(validateAssertionName('a'.repeat(257)).valid).toBe(false);
  });
});

describe('validateSubGraphName', () => {
  it('accepts valid sub-graph names', () => {
    expect(validateSubGraphName('my-sub-graph').valid).toBe(true);
  });

  it('rejects empty names', () => {
    expect(validateSubGraphName('').valid).toBe(false);
  });

  it('rejects underscore-prefixed (reserved)', () => {
    expect(validateSubGraphName('_internal').valid).toBe(false);
  });

  it('rejects slashes', () => {
    expect(validateSubGraphName('a/b').valid).toBe(false);
  });

  it('rejects reserved path segments', () => {
    expect(validateSubGraphName('context').valid).toBe(false);
    expect(validateSubGraphName('assertion').valid).toBe(false);
    expect(validateSubGraphName('draft').valid).toBe(false);
  });

  it('rejects IRI-unsafe characters', () => {
    expect(validateSubGraphName('a<b').valid).toBe(false);
    expect(validateSubGraphName('a b').valid).toBe(false);
  });
});

describe('deriveCuratorDidFromCgId (V10 wallet-scoped fallback)', () => {
  // Why these tests exist: this fallback is the only thing standing
  // between users and a complete-silent-rejection of every join request
  // for any CG whose RDF `_meta` curator triple is missing locally
  // (most commonly: on-chain CG registration didn't complete on the
  // creating node). The bug is invisible — RDF query returns null →
  // PROTOCOL_JOIN_REQUEST handler returns "unknown CG" with no log.
  // Every regression here would re-introduce that failure mode.

  it('extracts curator DID from a wallet-prefixed cgId', () => {
    expect(
      deriveCuratorDidFromCgId('0xd46E77003d74df9aAdF011A5115A72405b084a88/eems1'),
    ).toBe('did:dkg:agent:0xd46E77003d74df9aAdF011A5115A72405b084a88');
  });

  it('preserves EIP-55 checksum case from the cgId', () => {
    // We deliberately don't normalise here — the comparison site is
    // case-insensitive (lowercased on both sides) so case-preservation
    // keeps the returned DID legible in logs/errors. If we ever
    // canonicalised here, the comparison code's lowercasing would
    // still work, but log lines would lie about what was on the wire.
    const checksumDid = deriveCuratorDidFromCgId('0xAbCdEf0000000000000000000000000000000000/foo');
    expect(checksumDid).toBe('did:dkg:agent:0xAbCdEf0000000000000000000000000000000000');
  });

  it('accepts cgIds with multi-segment names (slashes after the wallet)', () => {
    // The name part is `^.+$` so anything non-empty after the wallet
    // counts. Sub-paths like `0xWALLET/proj/sub` are still
    // wallet-scoped to the same curator.
    expect(
      deriveCuratorDidFromCgId('0x227e428480f965ee1d99FA16a4AbBc6F554159b9/proj/sub'),
    ).toBe('did:dkg:agent:0x227e428480f965ee1d99FA16a4AbBc6F554159b9');
  });

  it('returns null for legacy non-prefixed cgIds (V9 globals)', () => {
    // These genuinely have no derivable curator — caller should fall
    // back to "unknown CG" rather than guess.
    expect(deriveCuratorDidFromCgId('hbad-5')).toBeNull();
    expect(deriveCuratorDidFromCgId('demo-final')).toBeNull();
    expect(deriveCuratorDidFromCgId('testing')).toBeNull();
  });

  it('returns null for system context graphs (no wallet prefix)', () => {
    expect(deriveCuratorDidFromCgId('agents')).toBeNull();
    expect(deriveCuratorDidFromCgId('ontology')).toBeNull();
  });

  it('returns null for cgIds that look wallet-prefixed but aren\'t', () => {
    // Wrong hex length (39 chars instead of 40)
    expect(deriveCuratorDidFromCgId('0x123/foo')).toBeNull();
    // Non-hex chars after 0x
    expect(deriveCuratorDidFromCgId('0xZZZZ77003d74df9aAdF011A5115A72405b084a88/foo')).toBeNull();
    // Missing 0x prefix
    expect(deriveCuratorDidFromCgId('d46E77003d74df9aAdF011A5115A72405b084a88/foo')).toBeNull();
    // Wallet but no name part
    expect(deriveCuratorDidFromCgId('0xd46E77003d74df9aAdF011A5115A72405b084a88/')).toBeNull();
    // Wallet with no separator
    expect(deriveCuratorDidFromCgId('0xd46E77003d74df9aAdF011A5115A72405b084a88')).toBeNull();
  });

  it('returns null for empty/whitespace input', () => {
    expect(deriveCuratorDidFromCgId('')).toBeNull();
  });
});
