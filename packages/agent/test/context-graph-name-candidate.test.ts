import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import {
  CONTEXT_GRAPH_NAME_CANDIDATE_MAX_LENGTH,
  contextGraphNameCommitmentOf,
  findContextGraphNameInOntologyQuads,
  findVerifiedContextGraphName,
  normalizeContextGraphNameHash,
  verifyContextGraphNameCandidate,
} from '../src/context-graph-name-candidate.js';

const hashOf = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
const CLEARTEXT = '0x64529c023d853371228923b4fda5fb22f929bf51/fun-facts';
const NAME_HASH = hashOf(CLEARTEXT);
const ONTOLOGY = 'did:dkg:context-graph:ontology';

describe('Context Graph name candidate verification', () => {
  it('accepts exactly the preimage of the on-chain name hash', () => {
    expect(contextGraphNameCommitmentOf(CLEARTEXT)).toBe(NAME_HASH);
    expect(verifyContextGraphNameCandidate(CLEARTEXT, NAME_HASH)).toBe(CLEARTEXT);
    // The hash may arrive in any case; the commitment is compared canonically.
    expect(verifyContextGraphNameCandidate(CLEARTEXT, NAME_HASH.toUpperCase().replace('0X', '0x')))
      .toBe(CLEARTEXT);
  });

  it('rejects a candidate whose commitment does not match', () => {
    expect(verifyContextGraphNameCandidate('0x64529c023d853371228923b4fda5fb22f929bf51/fun-fact', NAME_HASH))
      .toBeNull();
    expect(verifyContextGraphNameCandidate(CLEARTEXT.toUpperCase(), NAME_HASH)).toBeNull();
    // The hash itself is not its own preimage.
    expect(verifyContextGraphNameCandidate(NAME_HASH, NAME_HASH)).toBeNull();
  });

  it('rejects garbage without hashing it', () => {
    for (const garbage of [undefined, null, 42, {}, [], '', ' ', 'a b', 'x\u0000y', 'ok/../escape', '"quoted"']) {
      expect(verifyContextGraphNameCandidate(garbage, NAME_HASH)).toBeNull();
    }
    // A malformed expected hash never matches anything.
    expect(verifyContextGraphNameCandidate(CLEARTEXT, '0x1234')).toBeNull();
    expect(verifyContextGraphNameCandidate(CLEARTEXT, 'not-a-hash')).toBeNull();
  });

  it('rejects an oversized candidate before hashing it', () => {
    // Its commitment really is `hugeHash`, so only the length bound rejects it.
    const huge = 'a'.repeat(2 * 1024 * 1024);
    const hugeHash = hashOf(huge);
    expect(verifyContextGraphNameCandidate(huge, hugeHash)).toBeNull();
    const atLimit = 'b'.repeat(CONTEXT_GRAPH_NAME_CANDIDATE_MAX_LENGTH);
    expect(verifyContextGraphNameCandidate(atLimit, hashOf(atLimit))).toBe(atLimit);
    const overLimit = `${atLimit}b`;
    expect(verifyContextGraphNameCandidate(overLimit, hashOf(overLimit))).toBeNull();
  });

  it('normalizes only well-formed 32-byte hashes', () => {
    expect(normalizeContextGraphNameHash(NAME_HASH.toUpperCase().replace('0X', '0x'))).toBe(NAME_HASH);
    expect(normalizeContextGraphNameHash(NAME_HASH.slice(0, -1))).toBeNull();
    expect(normalizeContextGraphNameHash(`${NAME_HASH}00`)).toBeNull();
    expect(normalizeContextGraphNameHash(7)).toBeNull();
  });

  it('returns the first verified candidate of a mixed list', () => {
    expect(findVerifiedContextGraphName(['nope', 12, CLEARTEXT, 'later'], NAME_HASH)).toBe(CLEARTEXT);
    expect(findVerifiedContextGraphName(['nope', 'still-nope'], NAME_HASH)).toBeNull();
  });
});

describe('ontology scan', () => {
  const definition = (id: string) => ({
    subject: `did:dkg:context-graph:${id}`,
    predicate: DKG_ONTOLOGY.RDF_TYPE,
    object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
    graph: ONTOLOGY,
  });

  it('finds a definition whose id contains slashes', () => {
    const quads = [definition('other'), definition(CLEARTEXT)];
    expect(findContextGraphNameInOntologyQuads(quads, NAME_HASH)).toBe(CLEARTEXT);
  });

  it('finds a registration row by its on-chain id binding subject', () => {
    const quads = [{
      subject: `did:dkg:context-graph:${CLEARTEXT}`,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: '"33"',
      graph: ONTOLOGY,
    }];
    expect(findContextGraphNameInOntologyQuads(quads, NAME_HASH)).toBe(CLEARTEXT);
  });

  it('ignores other predicates, other subjects and non-matching definitions', () => {
    const quads = [
      { subject: `did:dkg:context-graph:${CLEARTEXT}`, predicate: 'http://schema.org/name', object: '"x"', graph: ONTOLOGY },
      { subject: `urn:other:${CLEARTEXT}`, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ONTOLOGY },
      definition('curated-secret'),
    ];
    expect(findContextGraphNameInOntologyQuads(quads, NAME_HASH)).toBeNull();
  });
});
