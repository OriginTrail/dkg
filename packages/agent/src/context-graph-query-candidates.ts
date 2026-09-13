// SPDX-License-Identifier: Apache-2.0

import {
  assertSafeIri,
  parseContextGraphAssertionUri,
  validateContextGraphId,
  validateNewContextGraphId,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { mapWithConcurrency } from './map-with-concurrency.js';

const GRAPH_PREFIX = 'did:dkg:context-graph:';
const METADATA_BATCH_SIZE = 128;
const METADATA_DISCOVERY_CONCURRENCY = 4;

/**
 * Inventory for unscoped read admission, independent of policy acceptance.
 * These are possible owners, not declarations or permission grants. In legacy
 * memory URIs a slash-bearing root and a root plus named subgraph can alias;
 * both owners must pass ordinary read authority before arbitrary SPARQL runs.
 */
export async function listStoredContextGraphQueryCandidates(store: TripleStore): Promise<string[]> {
  const options = { source: 'agent.query.rfc64RuntimePrivateGraphs' };
  const graphUris = store.listGraphsByPrefix
    ? await store.listGraphsByPrefix(GRAPH_PREFIX, options)
    : (await store.listGraphs(options)).filter((uri) => uri.startsWith(GRAPH_PREFIX));
  const candidates = new Set<string>();
  const ownMetadata: { graph: string; subject: string }[] = [];
  const add = (id: string) => {
    if (validateContextGraphId(id).valid) candidates.add(id);
  };
  const addParent = (scope: string) => {
    if (!validateContextGraphId(scope).valid) return;
    const slash = scope.lastIndexOf('/');
    if (slash > 0 && validateSubGraphName(scope.slice(slash + 1)).valid) {
      add(scope.slice(0, slash));
    }
  };
  const addScope = (scope: string) => {
    add(scope);
    addParent(scope);
  };

  for (const graph of graphUris) {
    if (!graph.startsWith(GRAPH_PREFIX)) continue;
    const tail = graph.slice(GRAPH_PREFIX.length);
    // RFC-64 scopes encode the entire CG component, avoiding legacy ambiguity.
    const encoded = /^v1\/(?:root|subgraph)\/([^/]+)\//.exec(tail);
    if (encoded) {
      add(decodeURIComponent(encoded[1]));
      // Unescaped components can also be a valid legacy root such as
      // v1/root/private. Keep that interpretation below instead of letting
      // the tagged namespace hide a separately registered legacy owner.
    }

    const context = /^(.*)\/context\/[^/]+(?:\/_meta)?$/.exec(tail);
    if (context) add(context[1]);
    // Name-keyed working memory predates per-KA layer graphs and remains a
    // supported read/write fallback. Its assertion URI is also the graph URI.
    const assertion = parseContextGraphAssertionUri(graph);
    if (assertion) addScope(assertion.scope);

    // Underscore segments are reserved storage partitions in new CG IDs.
    // Include memory, per-asset metadata, rules and sync partitions without
    // maintaining a second list of layer names. Plain root metadata/catalog
    // uses the exact-own-subject qualification below.
    const partition = /\/_[^/]+(?:\/|$)/.exec(tail);
    if (partition && !['/_meta', '/_catalog'].includes(tail.slice(partition.index))) {
      addScope(tail.slice(0, partition.index));
      // Older roots may contain reserved segments. Still check their exact
      // own metadata below rather than discarding that ownership evidence.
    }

    const metadataSuffix = ['/_meta', '/_catalog'].find((suffix) => tail.endsWith(suffix));
    if (metadataSuffix) {
      const id = tail.slice(0, -metadataSuffix.length);
      // A named subgraph's bookkeeping may outlive the root's definition.
      // Its parent remains an owner even without an exact self-declaration.
      if (metadataSuffix === '/_meta') addParent(id);
      if (!id.includes('/')) add(id);
      else {
        // Ordinary subgraph bookkeeping must not invent a root. Only facts
        // about this exact subject in its own partition establish a candidate.
        const subject = `${GRAPH_PREFIX}${id}`;
        assertSafeIri(graph);
        assertSafeIri(subject);
        ownMetadata.push({ graph, subject });
      }
      continue;
    }

    // Bare data graphs may themselves have slash-bearing IDs. Retain these
    // even when /context/<id> also names a possible owner above.
    if (!tail.includes('/') || validateNewContextGraphId(tail).valid) addScope(tail);
  }

  const batches = [];
  for (let offset = 0; offset < ownMetadata.length; offset += METADATA_BATCH_SIZE) {
    batches.push(ownMetadata.slice(offset, offset + METADATA_BATCH_SIZE));
  }
  const discovered = await mapWithConcurrency(batches, METADATA_DISCOVERY_CONCURRENCY, async (batch) => {
    const result = await store.query(`SELECT DISTINCT ?cg WHERE {
      VALUES (?g ?cg) { ${batch.map(({ graph, subject }) => `(<${graph}> <${subject}>)`).join(' ')} }
      FILTER EXISTS { GRAPH ?g { ?cg ?predicate ?object } }
    }`, { source: 'agent.query.storedContextGraphCandidates' });
    if (result.type !== 'bindings') {
      throw new Error('Cannot authorize unscoped query: invalid context-graph metadata discovery result');
    }
    return result.bindings.flatMap((row) => {
      const match = row['cg']?.match(/^<?did:dkg:context-graph:([^>]+)>?$/);
      return match?.[1] ? [match[1]] : [];
    });
  });
  for (const ids of discovered) for (const id of ids) add(id);
  return [...candidates];
}
