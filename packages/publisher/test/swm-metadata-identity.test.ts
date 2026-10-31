// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { contextGraphSharedMemoryMetaUri } from '@origintrail-official/dkg-core';
import { generateShareMetadata } from '../src/metadata.js';
import { decodeSwmOperationIdentity, matchesSwmMetadataIdentity } from '../src/swm-metadata-identity.js';

const cg = 'tenant:alpha';
const id = 'operation:7';
it.each([undefined, 'research'])('canonical producer identity is shared across readers in %s', subGraphName => {
  const graph = contextGraphSharedMemoryMetaUri(cg, subGraphName);
  const rows = generateShareMetadata({ contextGraphId: cg, shareOperationId: id, rootEntities: ['urn:root'],
    publisherPeerId: 'peer', timestamp: new Date(0), subGraphName }, graph);
  const identity = decodeSwmOperationIdentity(rows[0]!.subject, graph)!;
  expect(identity).toEqual({ contextGraphId: cg, shareOperationId: id, ...(subGraphName ? { subGraphName } : {}) });
  expect(matchesSwmMetadataIdentity(rows, identity, 'graph-admission')).toBe(true);
  expect(matchesSwmMetadataIdentity(rows, identity, 'snapshot-readiness')).toBe(true);
  const missing = rows.filter(row => !row.predicate.endsWith('contextGraphId') && !row.predicate.endsWith('shareOperationId') && !row.predicate.endsWith('subGraphName'));
  expect(matchesSwmMetadataIdentity(missing, identity, 'historical-admission')).toBe(true);
  expect(matchesSwmMetadataIdentity(missing, identity, 'graph-admission')).toBe(false);
  expect(matchesSwmMetadataIdentity(missing, identity, 'snapshot-readiness')).toBe(false);
  const claim = rows.find(row => row.predicate.endsWith('contextGraphId'))!;
  const equivalent = [...rows, { ...claim, object: `"${cg}"^^<http://www.w3.org/2001/XMLSchema#string>` }];
  expect(matchesSwmMetadataIdentity(equivalent, identity, 'graph-admission')).toBe(true);
  expect(matchesSwmMetadataIdentity(equivalent, identity, 'snapshot-readiness')).toBe(false);
  const nonliteral = rows.map(row => row === claim ? { ...row, object: 'urn:foreign' } : row);
  expect(matchesSwmMetadataIdentity(nonliteral, identity, 'historical-admission')).toBe(false);
});
it.each([
  ['urn:other:cg:op', contextGraphSharedMemoryMetaUri(cg)],
  [`urn:dkg:share:${cg}:`, contextGraphSharedMemoryMetaUri(cg)],
  [`urn:dkg:share:${cg}:unsafe>`, contextGraphSharedMemoryMetaUri(cg)],
  [`urn:dkg:share:${cg}:${id}`, 'urn:other:metadata'],
  [`urn:dkg:share:${cg}:${id}`, `did:dkg:context-graph:${cg}/_shared_memory`],
  [`urn:dkg:share:${cg}:${id}`, `did:dkg:context-graph:${cg}/bad name/_shared_memory_meta`],
])('rejects noncanonical wire subject %s in %s', (subject, graph) => {
  expect(decodeSwmOperationIdentity(subject, graph)).toBeUndefined();
});
