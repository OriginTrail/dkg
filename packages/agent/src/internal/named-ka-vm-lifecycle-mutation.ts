// SPDX-License-Identifier: Apache-2.0

import {
  MemoryLayer,
  formatSparqlTerm,
  sparqlString,
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  type Quad,
} from '@origintrail-official/dkg-storage';
import { VM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';

const MEMORY_LAYER_PRED = 'http://dkg.io/ontology/memoryLayer';
const STATE_PRED = 'http://dkg.io/ontology/state';
const PUBLISHED_UAL_PRED = 'http://dkg.io/ontology/publishedUal';
const ASSERTION_GRAPH_PRED = 'http://dkg.io/ontology/assertionGraph';

export interface PublishedNamedKaVmLifecycleInput {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly publishedUal: string;
  /** The chain-current root to materialize, which may supersede the queued root. */
  readonly merkleRoot: string;
  readonly packedKaId?: bigint;
  /** Incomplete-descriptor repair has already proved these fields; never replace its retry evidence. */
  readonly preserveVerifiedVmProof?: boolean;
}

import type { StoreMutation } from './store-mutation.js';

/** One validated source of truth for query scope and observer scope; no caller-supplied hints. */
export function buildNamedKaVmLifecycleMutation(input: PublishedNamedKaVmLifecycleInput): {
  readonly replacements: readonly Quad[];
  readonly graph: string;
  readonly sparql: string;
  readonly mutation: StoreMutation;
} {
  const assertionUri = contextGraphAssertionUri(
    input.contextGraphId,
    input.agentAddress,
    input.name,
    input.subGraphName,
  );
  const lifecycleUri = assertionLifecycleUri(
    input.contextGraphId,
    input.agentAddress,
    input.name,
    input.subGraphName,
  );
  const metaGraph = contextGraphMetaUri(input.contextGraphId);
  const bareMerkleRoot = input.merkleRoot.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(bareMerkleRoot)) {
    throw new Error(
      `Cannot stamp named KA VM lifecycle for "${input.name}": invalid merkle root ${input.merkleRoot}`,
    );
  }

  const replacement = (subject: string, predicate: string, object: string): Quad => ({
    subject, predicate, object, graph: metaGraph,
  });
  const replacements = [
    ...(input.preserveVerifiedVmProof ? [] : [
      replacement(lifecycleUri, VM_CURRENT_ASSERTION_PRED, sparqlString(bareMerkleRoot)),
      replacement(lifecycleUri, MEMORY_LAYER_PRED, sparqlString(MemoryLayer.VerifiableMemory)),
    ]),
    replacement(assertionUri, MEMORY_LAYER_PRED, sparqlString(MemoryLayer.VerifiableMemory)),
    replacement(lifecycleUri, STATE_PRED, sparqlString('published')),
    replacement(lifecycleUri, PUBLISHED_UAL_PRED, sparqlString(input.publishedUal)),
  ];

  // Without a packed ID, preserve both existing graph pointers exactly as before.
  if (input.packedKaId !== undefined) {
    const vmAuthor = `0x${(input.packedKaId >> 96n).toString(16).padStart(40, '0')}`;
    const vmNumber = input.packedKaId & ((1n << 96n) - 1n);
    const layerGraph = (layer: MemoryLayer) => contextGraphLayerUri(
      input.contextGraphId, layer, vmAuthor, vmNumber, input.subGraphName,
    );
    replacements.push(
      replacement(lifecycleUri, ASSERTION_GRAPH_PRED, layerGraph(MemoryLayer.VerifiableMemory)),
      replacement(layerGraph(MemoryLayer.WorkingMemory), MEMORY_LAYER_PRED, sparqlString(MemoryLayer.VerifiableMemory)),
    );
  }

  // Validate every term before any mutation, including optional graph pointers.
  // Keep RDF Quad fields separate from rendered SPARQL so fallback uses the same terms.
  const graph = formatSparqlTerm(metaGraph, { position: 'graph' });
  const values = replacements.map(({ subject, predicate, object }) => `(
    ${formatSparqlTerm(subject, { position: 'subject' })}
    ${formatSparqlTerm(predicate, { position: 'predicate' })}
    ${formatSparqlTerm(object, { position: 'object' })}
  )`).join('\n');
  return {
    replacements,
    graph: metaGraph,
    sparql: `
      DELETE { GRAPH ${graph} { ?subject ?predicate ?previous } }
      INSERT { GRAPH ${graph} { ?subject ?predicate ?replacement } }
      WHERE {
        VALUES (?subject ?predicate ?replacement) { ${values} }
        OPTIONAL { GRAPH ${graph} { ?subject ?predicate ?previous } }
      }
    `,
    mutation: {
      removals: replacements.map(({ subject, predicate }) => ({ graph: metaGraph, subject, predicate })),
      quads: replacements,
    },
  };
}
