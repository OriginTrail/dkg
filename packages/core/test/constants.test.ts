import { describe, it, expect } from 'vitest';
import {
  contextGraphSharedMemoryTopic,
  contextGraphFinalizationTopic,
  contextGraphAppTopic,
  contextGraphDataUri,
  contextGraphSessionsTopic,
  contextGraphPublishTopic,
  contextGraphWorkspaceTopic,
  kcUal,
  parseUal,
  publisherAddressFromUal,
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

describe('kcUal (OT-RFC-40 §5.2)', () => {
  // The default-storage 3-segment form MUST be preserved bit-for-bit
  // forever — every UAL ever minted under V10 (which defaults to
  // empty storage tag) keeps resolving without any rewrite. These
  // tests pin that contract.

  it('produces the legacy 3-segment form when no storage tag is supplied', () => {
    expect(kcUal('base:84532', '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1', 12345n)).toBe(
      'did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/12345',
    );
  });

  it('produces the legacy 3-segment form when storage tag is the empty string', () => {
    expect(kcUal('base:84532', '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1', 12345n, '')).toBe(
      'did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/12345',
    );
  });

  it('produces the 4-segment tagged form when a non-empty storage tag is supplied', () => {
    // V9 KAS today uses uriBase did:dkg:v9, so its UALs are 4-segment.
    // This is the format precedent the RFC standardises for V11+.
    expect(kcUal('base:84532', '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1', 17n, 'v9')).toBe(
      'did:dkg:v9/base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/17',
    );
  });

  it('accepts a string localId (tentative-publish path uses t<publishOperationId>)', () => {
    // Pre-confirmation, dkg-publisher.ts mints a synthetic ID of the
    // form `t<sessionId>-<seq>`. The helper must not coerce or reject
    // it — same shape goes into store.nq as the tentative subject
    // prefix and gets rewritten to the chain-issued KAID once
    // confirmation lands.
    expect(
      kcUal(
        'base:84532',
        '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
        'tabcd1234-5',
      ),
    ).toBe(
      'did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/tabcd1234-5',
    );
  });

  it('preserves EIP-55 checksum case in publisher addresses', () => {
    // Same rationale as deriveCuratorDidFromCgId — comparison sites
    // lowercase, but logs/errors stay legible if the original case is
    // preserved on the wire.
    expect(
      kcUal(
        'base:84532',
        '0xd46E77003d74df9aAdF011A5115A72405b084a88',
        1n,
      ),
    ).toBe('did:dkg:base:84532/0xd46E77003d74df9aAdF011A5115A72405b084a88/1');
  });

  it('does not interpolate or validate any field — caller responsibility', () => {
    // Mirror of contextGraphDataUri's "we don't sanitize slashes"
    // contract: the helper is dumb concatenation. Validation lives at
    // upload paths (validateContextGraphId etc.). This test pins that
    // the helper does not silently mangle inputs that the caller
    // passes in deliberately.
    expect(kcUal('chainId', 'pub', 0n)).toBe('did:dkg:chainId/pub/0');
    expect(kcUal('chainId', 'pub', 0n, 'tag')).toBe('did:dkg:tag/chainId/pub/0');
  });
});

describe('parseUal (OT-RFC-40 §5.2 — handles both 3- and 4-segment forms)', () => {
  // The parser must accept exactly the two shapes `kcUal()` produces
  // and reject everything else. These tests pin both directions.

  it('parses the legacy 3-segment / default-storage form', () => {
    const parsed = parseUal(
      'did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/12345',
    );
    expect(parsed).toEqual({
      chainId: 'base:84532',
      storageTag: '',
      publisherAddress: '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
      startKAId: 12345n,
    });
  });

  it('parses the 4-segment / storage-tagged form (V9 KAS today)', () => {
    const parsed = parseUal(
      'did:dkg:v9/base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/17',
    );
    expect(parsed).toEqual({
      chainId: 'base:84532',
      storageTag: 'v9',
      publisherAddress: '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
      startKAId: 17n,
    });
  });

  it('round-trips with kcUal for both forms', () => {
    const cid = 'base:84532';
    const pub = '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1';
    const id = 99n;
    expect(parseUal(kcUal(cid, pub, id))).toEqual({
      chainId: cid,
      storageTag: '',
      publisherAddress: pub,
      startKAId: id,
    });
    expect(parseUal(kcUal(cid, pub, id, 'v9'))).toEqual({
      chainId: cid,
      storageTag: 'v9',
      publisherAddress: pub,
      startKAId: id,
    });
  });

  it('returns null for inputs that do not start with did:dkg:', () => {
    expect(parseUal('http://example.org/1')).toBeNull();
    expect(parseUal('urn:dkg:agent:foo')).toBeNull();
    expect(parseUal('')).toBeNull();
  });

  it('returns null when fewer than 3 segments follow did:dkg:', () => {
    // 1 or 2 segments — covers CG/data URIs that share the prefix.
    expect(parseUal('did:dkg:context-graph:agents')).toBeNull();
    expect(parseUal('did:dkg:foo/bar')).toBeNull();
  });

  it('tolerates trailing per-KA suffix segments (default-storage form)', () => {
    // store.nq subjects sometimes carry a per-KA index after the kcId
    // (e.g. `did:dkg:base:84532/0xPub/123/7` ≡ KA #7 inside KC #123).
    // The pre-RFC-40 verifyUALConsistency indexed segments[2] directly,
    // so it kept range-checking those subjects. parseUal must preserve
    // that behaviour or it would silently skip the check (Codex review
    // on PR #718).
    const parsed = parseUal(
      'did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/123/7',
    );
    expect(parsed).toEqual({
      chainId: 'base:84532',
      storageTag: '',
      publisherAddress: '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
      startKAId: 123n,
    });
  });

  it('tolerates trailing per-KA suffix segments (tagged form)', () => {
    const parsed = parseUal(
      'did:dkg:v9/base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/17/3/extra',
    );
    expect(parsed).toEqual({
      chainId: 'base:84532',
      storageTag: 'v9',
      publisherAddress: '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
      startKAId: 17n,
    });
  });

  it('returns null when any segment is empty', () => {
    expect(parseUal('did:dkg://0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/123')).toBeNull();
    expect(parseUal('did:dkg:base:84532//123')).toBeNull();
    expect(parseUal('did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/')).toBeNull();
    expect(
      parseUal(
        'did:dkg:v9//base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/123',
      ),
    ).toBeNull();
  });

  it('rejects malformed storage tags (uppercase, colon, special chars)', () => {
    // STORAGE_TAG_PATTERN = /^[a-z0-9-]+$/
    expect(parseUal('did:dkg:V9/base:84532/0xPub/123')).toBeNull();
    expect(parseUal('did:dkg:v9.1/base:84532/0xPub/123')).toBeNull();
    expect(parseUal('did:dkg:tag with space/base:84532/0xPub/123')).toBeNull();
    // Even legitimate-looking V11+ candidates with colons are rejected
    // because chainIds use ':' and parsing would be ambiguous.
    expect(parseUal('did:dkg:base:special/base:84532/0xPub/123')).toBeNull();
  });

  it('returns startKAId: null for non-numeric local-id slot (tentative publish form)', () => {
    // dkg-publisher.ts's tentative path uses `t${publishOperationId}`
    // — the parser must not reject these since they are valid in-flight
    // UALs that get rewritten to a chain-issued KAID on confirmation.
    const parsed = parseUal(
      'did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/tabcd-1',
    );
    expect(parsed).toEqual({
      chainId: 'base:84532',
      storageTag: '',
      publisherAddress: '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1',
      startKAId: null,
    });
  });

  it('handles undefined / null without throwing', () => {
    expect(parseUal(undefined)).toBeNull();
    expect(parseUal(null)).toBeNull();
  });

  it('preserves publisher address case (no EIP-55 normalisation in core)', () => {
    // Caller decides whether to checksum-normalise; core stays
    // ethers-free and returns the segment as-it-was.
    const parsed = parseUal(
      'did:dkg:base:84532/0xd46E77003d74df9aAdF011A5115A72405b084a88/1',
    );
    expect(parsed?.publisherAddress).toBe('0xd46E77003d74df9aAdF011A5115A72405b084a88');
  });

  it('accepts arbitrary non-UAL CG data URIs without confusion', () => {
    // contextGraphDataUri('agents', 'sub') = "did:dkg:context-graph:agents/context/sub"
    // → 2 segments after prefix → null. parseUal must not mistake CG
    // URIs for UALs.
    expect(parseUal('did:dkg:context-graph:agents/context/sub')).toBeNull();
    expect(parseUal('did:dkg:context-graph:agents')).toBeNull();
  });
});

describe('publisherAddressFromUal', () => {
  it('returns the publisher segment for a 3-segment UAL', () => {
    expect(
      publisherAddressFromUal(
        'did:dkg:base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/12345',
      ),
    ).toBe('0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1');
  });

  it('returns the publisher segment for a 4-segment / V9-tagged UAL', () => {
    // The duplicated helper inside dkg-publisher.ts only handled the
    // 3-segment form (it took segments[1]). Moving + generalising it
    // to core fixes a latent bug where V9 UALs would have returned
    // the storage tag instead of the publisher address.
    expect(
      publisherAddressFromUal(
        'did:dkg:v9/base:84532/0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1/17',
      ),
    ).toBe('0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1');
  });

  it('returns undefined for malformed input', () => {
    expect(publisherAddressFromUal(undefined)).toBeUndefined();
    expect(publisherAddressFromUal(null)).toBeUndefined();
    expect(publisherAddressFromUal('')).toBeUndefined();
    expect(publisherAddressFromUal('not-a-ual')).toBeUndefined();
    expect(publisherAddressFromUal('did:dkg:context-graph:agents')).toBeUndefined();
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
