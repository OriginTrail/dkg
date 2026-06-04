import { describe, expect, it } from 'vitest';
import {
  TypedEventBus,
  decodePublishAck,
  encodePublishRequest,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { PublishHandler } from '../src/publish-handler.js';
import { computeFlatKCRootV10 as computeFlatKCRoot } from '../src/merkle.js';

const CONTEXT_GRAPH = 'publish-handler-design-b';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const DKG = 'http://dkg.io/ontology/';

function q(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

function ntriples(quads: Quad[]): string {
  return quads
    .map((quad) => `<${quad.subject}> <${quad.predicate}> ${quad.object} .`)
    .join('\n');
}

describe('PublishHandler Design B metadata', () => {
  it('stores the real tokenId separately from wire compatibility row ids', async () => {
    const store = new OxigraphStore();
    const handler = new PublishHandler(store, new TypedEventBus());
    const roots = ['urn:test:design-b:one', 'urn:test:design-b:two'];
    const quads = [
      q(roots[0], 'http://schema.org/name', '"One"'),
      q(roots[1], 'http://schema.org/name', '"Two"'),
    ];
    const merkleRoot = computeFlatKCRoot(quads, []);
    const ual = 'did:dkg:mock:31337/0x0000000000000000000000000000000000000001/11';

    const ackData = await handler.handler(encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples(quads)),
      contextGraphId: CONTEXT_GRAPH,
      kas: [
        { tokenId: 1, rootEntity: roots[0], privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 },
        { tokenId: 2, rootEntity: roots[1], privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 },
      ],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x0000000000000000000000000000000000000001',
      startKAId: 11,
      endKAId: 11,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    }), 'peer-a');

    expect(decodePublishAck(ackData).accepted).toBe(true);

    const metadata = await store.query(
      `SELECT ?ka ?root ?token WHERE {
        GRAPH <${META_GRAPH}> {
          ?ka <${DKG}rootEntity> ?root ;
              <${DKG}tokenId> ?token ;
              <${DKG}partOf> <${ual}> .
        }
      } ORDER BY ?ka`,
    );

    expect(metadata.type).toBe('bindings');
    const rows = (metadata.type === 'bindings' ? metadata.bindings : []);
    expect(rows.map((row) => row.ka)).toEqual([`${ual}/1`, `${ual}/2`]);
    expect(rows.map((row) => row.root)).toEqual(roots);
    expect(rows.every((row) => row.token.includes('"11"'))).toBe(true);
  });
});
