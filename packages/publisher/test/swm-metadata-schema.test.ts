import { describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { storeWorkspaceOperationPublicQuads } from '../src/workspace-resolution.js';
import {
  SWM_PREDICATES, decodeSwmPublicSliceSubject, selectSwmRecordRows, emitSwmHead, emitSwmOwnership,
} from '../src/swm-metadata-schema.js';

describe('public slice identity admission', () => {
  it.each([undefined, 'public-data'])('decodes persisted producer identities in scope %s', async (subGraphName) => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const rootEntity = 'https://example.org/entity/a:b%20c#part';
    try {
      await storeWorkspaceOperationPublicQuads({
        store, graphManager, contextGraphId: 'tenant:alpha', shareOperationId: 'operation:7',
        rootEntities: [rootEntity], subGraphName, publisherPeerId: 'peer-1',
        quads: [{ subject: rootEntity, predicate: 'urn:value', object: '"one"', graph: '' }],
      });
      const graph = graphManager.sharedMemoryMetaUri('tenant:alpha', subGraphName);
      const result = await store.query(`SELECT ?s WHERE {
        GRAPH <${graph}> { ?s <http://dkg.io/ontology/publicSliceRootEntity> <${rootEntity}> }
      }`);
      if (result.type !== 'bindings') throw new Error('Expected slice identity bindings');
      expect(result.bindings).toHaveLength(1);
      expect(decodeSwmPublicSliceSubject(result.bindings[0].s)).toEqual({
        contextGraphId: 'tenant:alpha', shareOperationId: 'operation:7', rootEntity,
        ...(subGraphName ? { subGraphName } : {}),
      });
    } finally {
      await store.close();
    }
  });

  // Wire fixtures are independent of the encoder: aliases must not acquire a
  // second identity for the same operation/root when received from a peer.
  it.each([
    ['wrong namespace', 'urn:other:cg:_:op:urn%3Aroot'],
    ['missing component', 'urn:dkg:public-stage:cg:_:op'],
    ['extra component', 'urn:dkg:public-stage:cg:_:op:urn%3Aroot:extra'],
    ['empty component', 'urn:dkg:public-stage:cg:_:op:'],
    ['broken escape', 'urn:dkg:public-stage:cg:_:op:%ZZ'],
    ['invalid UTF-8', 'urn:dkg:public-stage:cg:_:op:%FF'],
    ['unsafe root', 'urn:dkg:public-stage:cg:_:op:urn%3Aroot%20space'],
    ['invalid subgraph', 'urn:dkg:public-stage:cg:..%2Fprivate:op:urn%3Aroot'],
    ['unsafe context', 'urn:dkg:public-stage:bad%20cg:_:op:urn%3Aroot'],
    ['unsafe operation', 'urn:dkg:public-stage:cg:_:op%3E:urn%3Aroot'],
    ['blank operation', 'urn:dkg:public-stage:cg:_:%20:urn%3Aroot'],
    ['noncanonical escape', 'urn:dkg:public-stage:cg:_:op:urn%3aroot'],
    ['encoded unreserved character', 'urn:dkg:public-stage:%63g:_:op:urn%3Aroot'],
  ])('rejects %s without throwing', (_name, subject) => {
    expect(decodeSwmPublicSliceSubject(subject)).toBeUndefined();
  });

  it('retains the historical wire identity with an encoded root IRI', () => {
    expect(decodeSwmPublicSliceSubject('urn:dkg:public-stage:cg:_:op:urn%3Aroot')).toEqual({
      contextGraphId: 'cg', shareOperationId: 'op', rootEntity: 'urn:root',
    });
  });
});

describe('SWM role projection', () => {
  it('preserves row order and duplicates while rejecting another role and an injected type', () => {
    const row = (predicate: string, object: string): Quad => ({
      subject: 'urn:dkg:share:cg:op', predicate, object, graph: 'urn:metadata',
    });
    const root = row('http://dkg.io/ontology/rootEntity', 'urn:root');
    const legacyMember = row('http://dkg.io/ontology/entity', 'urn:legacy');
    const operationType = row('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://dkg.io/ontology/WorkspaceOperation');
    const rows = [
      root,
      row('http://dkg.io/ontology/contentScopeVersion', '"2"'),
      operationType,
      row('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:forged:Authority'),
      legacyMember,
      root,
      row('urn:untrusted:permission', '"admin"'),
    ];
    expect(selectSwmRecordRows('legacyOperationV1', rows)).toEqual([root, operationType, legacyMember, root]);
    expect(rows).toHaveLength(7);
  });
});

describe('current SWM writer boundary', () => {
  it('derives deterministic wire order and runtime cardinality from the role schema', () => {
    const rows = emitSwmHead('urn:head', 'urn:meta', {
      shareOperationId: '"op"', assertionGraph: 'urn:assertion', assertionVersion: '"1"',
      kaUal: 'urn:ual', contentScopeVersion: '"2"',
    });
    expect(rows.map(row => row.predicate)).toEqual([
      SWM_PREDICATES.contentScopeVersion, SWM_PREDICATES.kaUal, SWM_PREDICATES.assertionVersion,
      SWM_PREDICATES.assertionGraph, SWM_PREDICATES.shareOperationId,
    ]);
    expect(() => Reflect.apply(emitSwmHead, undefined, [
      'urn:head', 'urn:meta', { contentScopeVersion: '"2"' },
    ])).toThrow('Missing headV2 field: kaUal');
    expect(() => Reflect.apply(emitSwmHead, undefined, [
      'urn:head', 'urn:meta', {
        contentScopeVersion: '"2"', kaUal: ['urn:ual'], assertionVersion: '"1"',
        assertionGraph: 'urn:assertion', shareOperationId: '"op"',
      },
    ])).toThrow('Invalid headV2 cardinality for field: kaUal');
  });

  it('rejects historical-only fields from untyped callers', () => {
    expect(() => Reflect.apply(emitSwmOwnership, undefined, [
      'urn:root', 'urn:meta', { workspaceOwner: '"peer"', wasAttributedTo: '"legacy"' },
    ])).toThrow('Unknown ownershipV1 field: wasAttributedTo');
  });
});
