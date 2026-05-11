// Round 4 review §8/§9/§10 regression — assertion seal rootEntities
// round-trip + safety rails.
//
// The seal block in `_meta` now carries `dkg:assertionRootEntity`
// triples (one per root entity captured at finalize time) so that
// `publishFromFinalizedAssertion` can scope its SWM SPARQL CONSTRUCT
// to exactly the assertion's quads instead of bundling everything
// currently sitting in shared memory. This file pins the wire shape
// and the IRI safety rails:
//
// - Build-then-parse round-trips the rootEntities verbatim.
// - The builder emits root entities as `<…>` IRI objects, not string
//   literals (so the `_meta` block reads cleanly via SPARQL VALUES).
// - Unsafe IRIs (containing `>` / control chars / etc.) are rejected
//   at the builder so a corrupt seal cannot interpolate into the
//   downstream `_loadSelectedSWMQuads` SPARQL CONSTRUCT.
// - Empty rootEntities arrays are rejected (the seal MUST commit to
//   at least one root entity).
// - Parsing an old-format seal without rootEntities throws — partial
//   seals signal `_meta` corruption and require re-finalize.

import { describe, it, expect } from 'vitest';
import {
  buildAssertionSealQuads,
  parseAssertionSealQuads,
  ASSERTION_SEAL_PREDICATES,
} from '../src/assertion-seal.js';

const ASSERTION_URI = 'urn:dkg:assertion:foo';
const META_GRAPH = 'did:dkg:context-graph:cg-1/_meta';

function makeBaseArgs(rootEntities: string[]) {
  return {
    assertionUri: ASSERTION_URI,
    metaGraph: META_GRAPH,
    merkleRoot: new Uint8Array(32).fill(0xab),
    authorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    authorAttestationR: new Uint8Array(32).fill(0x11),
    authorAttestationVS: new Uint8Array(32).fill(0x22),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: '0x666D0c3da3dBc946D5128D06115bb4eed4595580',
    finalizedAtIso: '2026-05-10T00:00:00.000Z',
    rootEntities,
  };
}

describe('assertion seal rootEntities round-trip', () => {
  it('builds + parses preserves rootEntities order and value', () => {
    const roots = [
      'urn:dkg:doc:hello',
      'http://example.com/entity/A',
      'did:dkg:agent:0x1234567890123456789012345678901234567890',
    ];
    const quads = buildAssertionSealQuads(makeBaseArgs(roots));
    const seal = parseAssertionSealQuads(quads, ASSERTION_URI);
    expect(seal).toBeDefined();
    expect(seal!.rootEntities).toEqual(roots);
  });

  it('emits rootEntities as IRI objects (`<…>`), not string literals', () => {
    const quads = buildAssertionSealQuads(makeBaseArgs(['urn:dkg:doc:foo']));
    const rootQuad = quads.find(
      (q) => q.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY,
    );
    expect(rootQuad).toBeDefined();
    expect(rootQuad!.object).toBe('<urn:dkg:doc:foo>');
    expect(rootQuad!.object.startsWith('"')).toBe(false);
  });

  it('rejects unsafe IRI characters at the builder boundary', () => {
    expect(() =>
      buildAssertionSealQuads(makeBaseArgs(['urn:dkg:doc:foo> } INJECT { '])),
    ).toThrow(/Unsafe rootEntity/);
    expect(() =>
      buildAssertionSealQuads(makeBaseArgs(['has spaces'])),
    ).toThrow(/Unsafe rootEntity/);
    expect(() => buildAssertionSealQuads(makeBaseArgs([''])))
      .toThrow(/Unsafe rootEntity/);
  });

  it('rejects an empty rootEntities array', () => {
    expect(() => buildAssertionSealQuads(makeBaseArgs([])))
      .toThrow(/non-empty/);
  });

  it('parsing a seal without rootEntities throws (corrupt _meta)', () => {
    const quads = buildAssertionSealQuads(makeBaseArgs(['urn:dkg:doc:foo']));
    const stripped = quads.filter(
      (q) => q.predicate !== ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY,
    );
    expect(() => parseAssertionSealQuads(stripped, ASSERTION_URI)).toThrow(
      /assertionRootEntity/,
    );
  });

  it('parsing a malformed assertionRootEntity object (string literal w/ quotes) throws', () => {
    const quads = buildAssertionSealQuads(makeBaseArgs(['urn:dkg:doc:foo']));
    const corrupt = quads.map((q) =>
      q.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY
        ? { ...q, object: '"urn:dkg:doc:foo"' /* string literal, not IRI */ }
        : q,
    );
    expect(() => parseAssertionSealQuads(corrupt, ASSERTION_URI)).toThrow(
      /Invalid assertionRootEntity IRI/,
    );
  });

  it('parses bare-IRI form (post storage round-trip) identical to <IRI> form', () => {
    // Real backends parse `<urn:foo>` as an IRI on insert and round-trip
    // back as the bare value `urn:foo` on read (e.g. oxigraph
    // `termToString` returns `t.value` for NamedNode). The parser must
    // accept both shapes — see the round-trip-bug fix in
    // `devnet/v10-stress/FINDINGS.md` Phase 2.
    const roots = ['urn:dkg:doc:foo', 'http://example.com/A'];
    const wrapped = buildAssertionSealQuads(makeBaseArgs(roots));
    const bare = wrapped.map((q) =>
      q.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY
        ? { ...q, object: q.object.replace(/^<(.+)>$/, '$1') }
        : q,
    );
    const sealFromBare = parseAssertionSealQuads(bare, ASSERTION_URI);
    const sealFromWrapped = parseAssertionSealQuads(wrapped, ASSERTION_URI);
    expect(sealFromBare!.rootEntities).toEqual(roots);
    expect(sealFromBare!.rootEntities).toEqual(sealFromWrapped!.rootEntities);
  });

  it('parser dedupes nothing — preserves duplicate rootEntities verbatim', () => {
    // The builder DOES NOT dedupe (caller responsibility); the parser
    // mirrors that. This pins the contract — a future refactor that
    // adds dedupe should update both sides + this test together.
    const roots = ['urn:dkg:doc:foo', 'urn:dkg:doc:bar', 'urn:dkg:doc:foo'];
    const quads = buildAssertionSealQuads(makeBaseArgs(roots));
    const seal = parseAssertionSealQuads(quads, ASSERTION_URI);
    expect(seal!.rootEntities).toEqual(roots);
  });
});
