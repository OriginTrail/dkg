import { describe, it, expect } from 'vitest';
import {
  contextGraphSharedMemoryTopic,
  contextGraphFinalizationTopic,
  contextGraphAppTopic,
  contextGraphDataUri,
  contextGraphSessionsTopic,
  contextGraphPublishTopic,
  contextGraphWorkspaceTopic,
  validateContextGraphId,
  validateSubGraphName,
  validateAssertionName,
  deriveCuratorDidFromCgId,
} from '../src/constants.js';
import { createOperationContext } from '../src/logger.js';

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
