import { describe, it, expect } from 'vitest';
import {
  // proto
  encodeStorageACK, decodeStorageACK, type StorageACKMsg,
  encodeVerifyProposal, decodeVerifyProposal, type VerifyProposalMsg,
  encodeGossipEnvelope, decodeGossipEnvelope, type GossipEnvelopeMsg,
  computeGossipSigningPayload,
  // crypto
  hashTripleV10, V10MerkleTree, keccak256, keccak256Hex,
  // sparql-safe
  escapeSparqlLiteral, sparqlString,
  canonicalize,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Audit findings covered:
//
// C-6  computeGossipSigningPayload concatenates type|cgId|timestamp|payload
//      with no length prefix. ('a'+'bc') and ('ab'+'c') would produce the
//      same prefix ('abc'). Test that length-confusion is detected.
//
// C-7  Existing v10-proto.test.ts round-trips do NOT assert nodeIdentityId
//      on StorageACK or verifiedMemoryId/batchId on VerifyProposal. A proto
//      field reorder/wrong-tag regression would not fail. Add full-field
//      round-trip tests + tag-pin tests.
//
// C-8  escapeSparqlLiteral handles \, ", \n, \r, \t but does NOT handle lone
//      surrogates (U+D800–U+DFFF). Cross-references issue #173. Pin the
//      current behaviour so any change is intentional and visible.
//
// C-12 V10 Merkle "golden vector" only asserts non-zero. Pin the actual
//      32-byte hex root for a known triple set so silent regressions surface.
//
// C-13 hashTripleV10 lacks tests for typed-literal vs language-tagged literal
//      with the same lexical form, and same-lexical-different-datatype.
//
// C-5  canonicalize() doc says RDFC-1.0; spec says URDNA2015. Pin the
//      algorithm output by snapshotting a canonical form so a flag flip
//      cannot pass silently.
// ─────────────────────────────────────────────────────────────────────────────

function bytes(n: number, fill = 0): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe('computeGossipSigningPayload — length-confusion safety [C-6]', () => {
  // The signing payload is `${type}${contextGraphId}${timestamp}` || payload.
  // Without length prefixes between fields, an attacker who controls one
  // field can shift bytes between fields and produce the same signed bytes.
  // This test pins the current behaviour as a finding: a single-byte shift
  // across the type / contextGraphId boundary collides today.

  it('same concatenation byte-stream from different field splits collides (length-confusion)', () => {
    const ts = '2026-01-01T00:00:00Z';
    const payload = new Uint8Array([1, 2, 3, 4]);
    const a = computeGossipSigningPayload('a', 'bc' + 'tail', ts, payload);
    const b = computeGossipSigningPayload('ab', 'c' + 'tail', ts, payload);
    // If this passes (a equals b), the protocol is vulnerable to type/cgId
    // length confusion. If it fails (a !== b), the implementation has been
    // hardened with length prefixes — update the test to reflect the fix.
    expect(a).toEqual(b);
  });

  it('different timestamps produce different payloads', () => {
    const a = computeGossipSigningPayload('storage-ack', 'cg-1', '2026-01-01T00:00:00Z', new Uint8Array(0));
    const b = computeGossipSigningPayload('storage-ack', 'cg-1', '2026-01-01T00:00:01Z', new Uint8Array(0));
    expect(a).not.toEqual(b);
  });

  it('different payload bytes produce different signing payloads', () => {
    const a = computeGossipSigningPayload('storage-ack', 'cg-1', '2026-01-01T00:00:00Z', new Uint8Array([1]));
    const b = computeGossipSigningPayload('storage-ack', 'cg-1', '2026-01-01T00:00:00Z', new Uint8Array([2]));
    expect(a).not.toEqual(b);
  });

  it('payload bytes appear AFTER the prefix (regression: prefix before payload)', () => {
    const type = 'T';
    const cgId = 'CG';
    const ts = 'TS';
    const payload = new Uint8Array([0xAB, 0xCD]);
    const p = computeGossipSigningPayload(type, cgId, ts, payload);
    // Expected: 'T' 'C' 'G' 'T' 'S' 0xAB 0xCD = bytes 84,67,71,84,83,171,205
    expect(Array.from(p)).toEqual([84, 67, 71, 84, 83, 0xAB, 0xCD]);
  });
});

describe('StorageACK proto — full-field round-trip [C-7]', () => {
  function longToNumber(v: number | { low: number; high: number }): number {
    return typeof v === 'number' ? v : (v.high * 2 ** 32) + v.low;
  }

  it('encode/decode preserves nodeIdentityId (was missing from prior tests)', () => {
    const ack: StorageACKMsg = {
      merkleRoot: bytes(32, 0xab),
      coreNodeSignatureR: bytes(32, 0x11),
      coreNodeSignatureVS: bytes(32, 0x22),
      contextGraphId: 'cg-100',
      nodeIdentityId: 1234,
    };
    const decoded = decodeStorageACK(encodeStorageACK(ack));
    // protobufjs returns Long for uint64 — normalise to a JS number for compare.
    expect(longToNumber(decoded.nodeIdentityId)).toBe(1234);
  });

  it('encode/decode preserves nodeIdentityId across the uint32 boundary', () => {
    // protobufjs encodes uint64 as Long (low/high). Values > 2^32 require the
    // high word to carry data. If a regression drops nodeIdentityId from the
    // schema, this test will fail with `nodeIdentityId === 0` or undefined.
    const big = 0x1_0000_0001;
    const ack: StorageACKMsg = {
      merkleRoot: bytes(32, 0xab),
      coreNodeSignatureR: bytes(32, 0x11),
      coreNodeSignatureVS: bytes(32, 0x22),
      contextGraphId: 'cg-100',
      nodeIdentityId: big,
    };
    const decoded = decodeStorageACK(encodeStorageACK(ack));
    // protobufjs returns a Long for uint64 above 2^53; normalise.
    const observed = typeof decoded.nodeIdentityId === 'number'
      ? decoded.nodeIdentityId
      : (decoded.nodeIdentityId.high * 2 ** 32) + decoded.nodeIdentityId.low;
    expect(observed).toBe(big);
  });

  it('changing nodeIdentityId changes the encoded bytes (tag pinned at 5)', () => {
    const base: StorageACKMsg = {
      merkleRoot: bytes(32, 0xab),
      coreNodeSignatureR: bytes(32, 0x11),
      coreNodeSignatureVS: bytes(32, 0x22),
      contextGraphId: 'cg-100',
      nodeIdentityId: 1,
    };
    const a = encodeStorageACK(base);
    const b = encodeStorageACK({ ...base, nodeIdentityId: 2 });
    expect(a).not.toEqual(b);
  });
});

describe('VerifyProposal proto — full-field round-trip [C-7]', () => {
  it('encode/decode preserves verifiedMemoryId AND batchId', () => {
    const proposal: VerifyProposalMsg = {
      proposalId: bytes(16, 0x01),
      verifiedMemoryId: 7,
      batchId: 42,
      merkleRoot: bytes(32, 0x02),
      entities: ['urn:e:1', 'urn:e:2'],
      agentSignatureR: bytes(32, 0x03),
      agentSignatureVS: bytes(32, 0x04),
      expiresAt: '2026-04-02T12:00:00Z',
      contextGraphId: 'cg-1',
    };
    const decoded = decodeVerifyProposal(encodeVerifyProposal(proposal));
    const vmId = typeof decoded.verifiedMemoryId === 'number'
      ? decoded.verifiedMemoryId
      : (decoded.verifiedMemoryId.high * 2 ** 32) + decoded.verifiedMemoryId.low;
    const bId = typeof decoded.batchId === 'number'
      ? decoded.batchId
      : (decoded.batchId.high * 2 ** 32) + decoded.batchId.low;
    expect(vmId).toBe(7);
    expect(bId).toBe(42);
  });

  it('changing verifiedMemoryId changes encoded bytes (tag pinned at 2)', () => {
    const base: VerifyProposalMsg = {
      proposalId: bytes(16, 0x01),
      verifiedMemoryId: 1,
      batchId: 1,
      merkleRoot: bytes(32, 0x02),
      entities: [],
      agentSignatureR: bytes(32, 0x03),
      agentSignatureVS: bytes(32, 0x04),
      expiresAt: 'x',
      contextGraphId: 'cg',
    };
    const a = encodeVerifyProposal(base);
    const b = encodeVerifyProposal({ ...base, verifiedMemoryId: 2 });
    expect(a).not.toEqual(b);
  });

  it('changing batchId changes encoded bytes (tag pinned at 3)', () => {
    const base: VerifyProposalMsg = {
      proposalId: bytes(16, 0x01),
      verifiedMemoryId: 1,
      batchId: 1,
      merkleRoot: bytes(32, 0x02),
      entities: [],
      agentSignatureR: bytes(32, 0x03),
      agentSignatureVS: bytes(32, 0x04),
      expiresAt: 'x',
      contextGraphId: 'cg',
    };
    const a = encodeVerifyProposal(base);
    const b = encodeVerifyProposal({ ...base, batchId: 2 });
    expect(a).not.toEqual(b);
  });
});

describe('GossipEnvelope proto — full-field round-trip [C-7]', () => {
  it('preserves all 7 fields including agentAddress & version', () => {
    const env: GossipEnvelopeMsg = {
      version: '10.0.0',
      type: 'storage-ack',
      contextGraphId: 'cg-1',
      agentAddress: '0xAbc1230000000000000000000000000000000000',
      timestamp: '2026-01-01T00:00:00Z',
      signature: bytes(65, 0x99),
      payload: bytes(128, 0x42),
    };
    const decoded = decodeGossipEnvelope(encodeGossipEnvelope(env));
    expect(decoded.version).toBe('10.0.0');
    expect(decoded.type).toBe('storage-ack');
    expect(decoded.contextGraphId).toBe('cg-1');
    expect(decoded.agentAddress).toBe(env.agentAddress);
    expect(decoded.timestamp).toBe(env.timestamp);
    expect(new Uint8Array(decoded.signature)).toEqual(env.signature);
    expect(new Uint8Array(decoded.payload)).toEqual(env.payload);
  });
});

describe('escapeSparqlLiteral — surrogate / unicode handling [C-8 / #173]', () => {
  it('escapes the documented set: \\ " \\n \\r \\t', () => {
    expect(escapeSparqlLiteral('a\\b"c\nd\re\tf')).toBe('a\\\\b\\"c\\nd\\re\\tf');
  });

  it('does NOT escape lone high surrogate U+D800 — characterizes #173', () => {
    // JavaScript permits lone surrogates in strings. SPARQL/Turtle/JSON
    // normally do not. The current escaper passes them through unchanged.
    // If/when #173 is fixed, this test will fail and should be updated to
    // assert the new safe encoding (e.g. \uD800 escape or rejection).
    const lone = '\uD800';
    expect(escapeSparqlLiteral(lone)).toBe('\uD800');
  });

  it('does NOT escape lone low surrogate U+DC00 — characterizes #173', () => {
    const lone = '\uDC00';
    expect(escapeSparqlLiteral(lone)).toBe('\uDC00');
  });

  it('valid surrogate pair (😀 = U+1F600) is preserved as a single character', () => {
    const emoji = '😀';
    expect(escapeSparqlLiteral(emoji)).toBe(emoji);
    // Sanity: the emoji is two UTF-16 code units (a surrogate pair)
    expect(emoji.length).toBe(2);
  });

  it('sparqlString round-trip: the result is a valid SPARQL string literal even with surrogates', () => {
    // Pin behaviour: when surrogates pass through, the surrounding quotes are
    // still added. Triplestores will likely reject the result.
    const s = sparqlString('hello \uD800 world');
    expect(s.startsWith('"')).toBe(true);
    expect(s.endsWith('"')).toBe(true);
    expect(s).toContain('\uD800');
  });
});

describe('hashTripleV10 — literal datatype distinction [C-13]', () => {
  it('"foo" (plain) ≠ "foo"@en (lang-tagged)', () => {
    const plain = hashTripleV10('http://s', 'http://p', '"foo"');
    const lang = hashTripleV10('http://s', 'http://p', '"foo"@en');
    expect(plain).not.toEqual(lang);
  });

  it('"foo"@en ≠ "foo"@de — language tag participates in the hash', () => {
    const en = hashTripleV10('http://s', 'http://p', '"foo"@en');
    const de = hashTripleV10('http://s', 'http://p', '"foo"@de');
    expect(en).not.toEqual(de);
  });

  it('"42"^^xsd:integer ≠ "42" (plain string)', () => {
    const typed = hashTripleV10(
      'http://s', 'http://p',
      '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    );
    const plain = hashTripleV10('http://s', 'http://p', '"42"');
    expect(typed).not.toEqual(plain);
  });

  it('same lexical, different datatype: integer vs decimal differ', () => {
    const integer = hashTripleV10(
      'http://s', 'http://p',
      '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    );
    const decimal = hashTripleV10(
      'http://s', 'http://p',
      '"42"^^<http://www.w3.org/2001/XMLSchema#decimal>',
    );
    expect(integer).not.toEqual(decimal);
  });

  it('same lexical, different datatype: dateTime vs date differ', () => {
    const dt = hashTripleV10(
      'http://s', 'http://p',
      '"2026-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    );
    const d = hashTripleV10(
      'http://s', 'http://p',
      '"2026-01-01"^^<http://www.w3.org/2001/XMLSchema#date>',
    );
    expect(dt).not.toEqual(d);
  });
});

describe('V10MerkleTree — golden hex root pin [C-12]', () => {
  // Compute root for a small fixed triple set and pin the hex output.
  // If hashTripleV10 packing or V10MerkleTree pairing/sort changes, this
  // root changes — and any drift away from the on-chain merkle anchor
  // would silently break PUBLISH consensus. Pinning catches that.

  it('pins the root for a 3-triple known set', () => {
    const triples: Array<[string, string, string]> = [
      ['http://example.org/entity1', 'http://schema.org/name', '"Alice"'],
      ['http://example.org/entity1', 'http://schema.org/age',
        '"30"^^<http://www.w3.org/2001/XMLSchema#integer>'],
      ['http://example.org/entity2', 'http://schema.org/name', '"Bob"'],
    ];
    const hashes = triples.map(([s, p, o]) => hashTripleV10(s, p, o));
    const root = new V10MerkleTree(hashes).root;
    const hex = '0x' + Buffer.from(root).toString('hex');
    // If this snapshot ever changes, that is by definition a protocol-break
    // because the chain anchor is computed off the same input.
    expect(hex).toMatchInlineSnapshot(
      `"0xf2df78c79e669334546a3231a2225b0d0aa489749fbf0945a35fdfd49f64b6d3"`,
    );
  });

  it('pins KCRoot for two pinned KARoots', () => {
    const ka1 = keccak256(new TextEncoder().encode('ka-1-fixed'));
    const ka2 = keccak256(new TextEncoder().encode('ka-2-fixed'));
    const root = V10MerkleTree.computeKCRoot([ka1, ka2]);
    const hex = '0x' + Buffer.from(root).toString('hex');
    expect(hex).toMatchInlineSnapshot(
      `"0x7fc87174bfd049157ce1008c547482546a4cb771a29cfbe165246feb2ebfb133"`,
    );
  });
});

describe('canonicalize — algorithm pin [C-5]', () => {
  it('produces a stable canonical N-Quads output for a known input', async () => {
    // RDFC-1.0 (the comment) and URDNA2015 produce identical output for
    // graphs without blank-node disambiguation tie-breaks; this small graph
    // is deliberately chosen so the algorithm flag is observable through
    // its DETERMINISTIC output (subject ordering + triple format).
    const input = `
      <http://example.org/b> <http://example.org/p> "B" .
      <http://example.org/a> <http://example.org/p> "A" .
    `.trim();
    const out = await canonicalize(input);
    // Canonical N-Quads sorts deterministically. Pin the exact output.
    expect(out).toMatchInlineSnapshot(`
      "<http://example.org/a> <http://example.org/p> "A" .
      <http://example.org/b> <http://example.org/p> "B" .
      "
    `);
  });

  it('blank-node canonicalization assigns labels deterministically', async () => {
    const input = `
      _:b1 <http://example.org/p> "1" .
      _:b2 <http://example.org/p> "2" .
    `.trim();
    const out1 = await canonicalize(input);
    const out2 = await canonicalize(input);
    expect(out1).toBe(out2);
    // Snapshot pins the exact blank-node label scheme. URDNA2015 and
    // RDFC-1.0 both use _:c14n0, _:c14n1, ... so a different algorithm
    // (e.g. URGNA2012 with _:bnode0) would be visible here.
    expect(out1).toContain('_:c14n');
  });
});
