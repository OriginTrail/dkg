/**
 * The protocol-metadata checks compare terms in the form the store writes
 * them: `<iri>` is stored as `iri`, so a bracketed trust-level predicate or
 * reserved subject is refused like the bare one.
 */
import { describe, expect, it } from 'vitest';
import {
  TRUST_LEVEL_PREDICATE,
  UserAuthoredTrustLevelError,
  WORKSPACE_OWNER_PREDICATE,
  isSwmMerkleExcludedQuad,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { ReservedNamespaceError } from '../src/errors.js';
import { computeFlatKCRootV10 } from '../src/merkle.js';
import {
  assertNoReceivedProtocolMetadata,
  rejectReservedSubjectPrefixes,
  rejectUserAuthoredProtocolMetadata,
} from '../src/protocol-metadata.js';
import { findReservedSubjectPrefix, isReservedSubject } from '../src/reserved-subjects.js';

function quad(subject: string, predicate: string, object = '"v"'): Quad {
  return { subject, predicate, object, graph: '' };
}

describe('reserved subjects', () => {
  it.each([
    ['bare', 'urn:dkg:file:abc', 'urn:dkg:file:'],
    ['in angle brackets', '<urn:dkg:file:abc>', 'urn:dkg:file:'],
    ['in another case, in angle brackets', '<URN:DKG:extraction:abc>', 'urn:dkg:extraction:'],
  ])('are found %s', (_form, subject, prefix) => {
    expect(findReservedSubjectPrefix(subject)).toBe(prefix);
    expect(isReservedSubject(subject)).toBe(true);
    expect(() => rejectReservedSubjectPrefixes([quad('urn:ok', 'urn:p'), quad(subject, 'urn:p')]))
      .toThrow(ReservedNamespaceError);
  });

  it('leave other subjects alone', () => {
    for (const subject of ['urn:dkg:filed:abc', '<urn:other:file:abc>', 'urn:dkg:file', 'http://example.org/urn:dkg:file:']) {
      expect(isReservedSubject(subject)).toBe(false);
    }
    expect(() => rejectReservedSubjectPrefixes([quad('<urn:ok>', 'urn:p')])).not.toThrow();
  });
});

describe('protocol metadata from a peer and from a local caller', () => {
  it.each<[string, Quad, new (...args: never[]) => Error]>([
    ['a trust-level row', quad('urn:s', TRUST_LEVEL_PREDICATE), UserAuthoredTrustLevelError],
    ['a bracketed trust-level row', quad('urn:s', `<${TRUST_LEVEL_PREDICATE}>`), UserAuthoredTrustLevelError],
    ['a reserved subject', quad('urn:dkg:file:abc', 'urn:p'), ReservedNamespaceError],
    ['a bracketed reserved subject', quad('<urn:dkg:file:abc>', 'urn:p'), ReservedNamespaceError],
  ])('refuses %s', (_label, refused, error) => {
    expect(() => assertNoReceivedProtocolMetadata([quad('urn:ok', 'urn:p'), refused])).toThrow(error);
    expect(() => rejectUserAuthoredProtocolMetadata([quad('urn:ok', 'urn:p'), refused])).toThrow(error);
  });

  it('accepts other quads, returning them for inline use', () => {
    const quads = [quad('urn:ok', 'http://schema.org/name'), quad('<urn:ok>', '<http://schema.org/name>')];
    expect(assertNoReceivedProtocolMetadata(quads)).toBe(quads);
    expect(() => rejectUserAuthoredProtocolMetadata(quads)).not.toThrow();
  });

  it('leaves a peer\'s canonical KA skolem terms to the graph-scoped validators, but refuses them from a local caller', () => {
    const quads = [quad('urn:dkg:ka-skolem:c14n0', 'http://schema.org/name')];
    expect(assertNoReceivedProtocolMetadata(quads)).toBe(quads);
    expect(() => rejectUserAuthoredProtocolMetadata(quads)).toThrow();
  });
});

describe('the SWM merkle root', () => {
  // The SWM read paths see quads read back from the store, so their
  // predicates are bare: the rows excluded, and the root, are unchanged.
  it('is recomputed over the same author rows as before', () => {
    const swm = [
      quad('urn:a', 'http://schema.org/name', '"A"'),
      quad('urn:a', TRUST_LEVEL_PREDICATE, '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'),
      quad('urn:a', WORKSPACE_OWNER_PREDICATE, '"peer"'),
      quad('urn:b', 'http://schema.org/name', '"B"'),
    ];
    const kept = swm.filter((row) => !isSwmMerkleExcludedQuad(row));
    expect(kept).toEqual([swm[0], swm[3]]);
    expect(computeFlatKCRootV10(kept, [])).toEqual(computeFlatKCRootV10([swm[0], swm[3]], []));
  });
});
