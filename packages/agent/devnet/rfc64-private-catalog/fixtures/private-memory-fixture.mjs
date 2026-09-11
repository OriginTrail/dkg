// SPDX-License-Identifier: Apache-2.0

import {
  MemoryLayer,
  contextGraphLayerUri,
  contextGraphMetaUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  PROJECTION_QUADS,
  UPDATED_PROJECTION_QUADS,
  privateCatalogSwmShareOperationId,
  roleAgentAddress,
} from '../fixture.mjs';
import {
  bindGraphlessProjectionToGraph,
  readPrivateCatalogWorkspaceMemoryEvidenceV1,
} from '../memory-evidence.mjs';

/** Seed the one canonical SWM-v2/VM-v1 state used by private-gate tests. */
export async function seedExpectedPrivateMemoryV1(store) {
  const authorAddress = roleAgentAddress('owner');
  const quads = ASSET_NUMBERS.flatMap((kaNumber) => {
    const kaUal = `did:dkg:${NETWORK_ID}/${authorAddress}/${kaNumber}`;
    const swmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.SharedWorkingMemory,
      authorAddress,
      kaNumber,
    );
    const vmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      authorAddress,
      kaNumber,
    );
    return [
      ...bindGraphlessProjectionToGraph(UPDATED_PROJECTION_QUADS, swmGraph),
      ...bindGraphlessProjectionToGraph(PROJECTION_QUADS, vmGraph),
      {
        subject: `${kaUal}#dkg-swm-head`,
        predicate: 'http://dkg.io/ontology/assertionVersion',
        object: '"2"',
        graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: `${kaUal}#dkg-swm-head`,
        predicate: 'http://dkg.io/ontology/assertionGraph',
        object: swmGraph,
        graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: `${kaUal}#dkg-swm-head`,
        predicate: 'http://dkg.io/ontology/shareOperationId',
        object: `"${privateCatalogSwmShareOperationId(kaNumber)}"`,
        graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: kaUal,
        predicate: 'http://dkg.io/ontology/assertionVersion',
        object: '"1"',
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: kaUal,
        predicate: 'http://dkg.io/ontology/assertionGraph',
        object: vmGraph,
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      },
    ];
  });
  await store.insert(quads);
}

export function readExpectedPrivateMemoryV1(store) {
  return readPrivateCatalogWorkspaceMemoryEvidenceV1(store, {
    assetNumbers: ASSET_NUMBERS,
    authorAddress: roleAgentAddress('owner'),
    contextGraphId: CONTEXT_GRAPH_ID,
    networkId: NETWORK_ID,
  });
}
