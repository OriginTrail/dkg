// SPDX-License-Identifier: Apache-2.0

/**
 * What one write does to the read graphs whose member graphs it touches. Pure:
 * the read-graph layer finds those read graphs and their membership, takes
 * their locks, and hands the result to the adapter.
 *
 * An insert adds its quads to each read graph in the same call. Every other
 * write gets the operations its adapter sends before and after the change, in
 * the same request (`./adapter-contract.ts`): a delta form where one gives the
 * same result as the reference procedure, and the reference procedure
 * otherwise. A delta form names each term as the adapter renders it for its
 * own statement, so both name the same stored term. A blank node cannot be
 * named that way, so a write with one takes the reference procedure, which
 * retracts and copies on the server: no write skips maintenance.
 */

import type { SparqlTermRenderer } from '../adapters/sparql-term-policy.js';
import type { Quad } from '../triple-store.js';
import {
  ReadGraphDeltaFormError,
  readGraphCopy,
  readGraphDeltaDelete,
  readGraphDeltaDeleteBySubjectPrefix,
  readGraphDeltaDeleteMatching,
  readGraphInsertQuads,
  readGraphReferenceProcedure,
  type ReadGraphTarget,
} from './statements.js';

/** A write, as the read-graph layer sees it. */
export type ReadGraphWrite =
  /** New quads; each goes into the read graphs of its graph, in the same call. */
  | { readonly kind: 'insert'; readonly quads: readonly Quad[] }
  /** Quads deleted one by one. */
  | { readonly kind: 'delete'; readonly quads: readonly Quad[] }
  /** Every triple of one graph that matches a pattern. */
  | {
    readonly kind: 'delete-matching';
    readonly graph: string;
    readonly pattern: Readonly<Pick<Partial<Quad>, 'subject' | 'predicate' | 'object'>>;
  }
  /** Every triple of one graph whose subject starts with a prefix. */
  | { readonly kind: 'delete-prefix'; readonly graph: string; readonly prefix: string }
  /** Any change to whole graphs. A dropped graph is empty afterwards, so nothing is copied back from it. */
  | { readonly kind: 'replace'; readonly graphs: readonly string[]; readonly dropped?: boolean }
  /** The rows of one subject in one graph, and the rows of companion subjects added to the same graph. */
  | { readonly kind: 'replace-subject'; readonly graph: string; readonly subject: string; readonly companions?: readonly string[] };

/** The graphs whose triples a write may change. */
export function readGraphWriteGraphs(write: ReadGraphWrite): string[] {
  switch (write.kind) {
    case 'insert':
    case 'delete':
      return [...new Set(write.quads.map((quad) => quad.graph))];
    case 'replace':
      return [...new Set(write.graphs)];
    default:
      return [write.graph];
  }
}

/** What one write does to one read graph. */
export interface ReadGraphWriteChange {
  /** Quads to add to the same insert call. */
  readonly insertQuads: readonly Quad[];
  /** Operations to send before the change, in the same request. */
  readonly before: readonly string[];
  /** Operations to send after the change, in the same request. */
  readonly after: readonly string[];
}

/**
 * The change to one read graph for a write. `members` holds the graphs of the
 * write that are members of the read graph; the others are ignored. `render`
 * is the renderer the adapter uses for its own statement.
 */
export function readGraphWriteChange(
  write: ReadGraphWrite,
  target: ReadGraphTarget,
  members: ReadonlySet<string>,
  render: SparqlTermRenderer,
): ReadGraphWriteChange {
  const none: ReadGraphWriteChange = { insertQuads: [], before: [], after: [] };
  const touched = readGraphWriteGraphs(write).filter((graph) => members.has(graph));
  if (touched.length === 0) return none;
  const reference = (stillMembers: readonly string[], subject?: string): ReadGraphWriteChange => ({
    insertQuads: [],
    ...readGraphReferenceProcedure(target, touched, stillMembers, subject === undefined ? {} : { subject, render }),
  });
  switch (write.kind) {
    case 'insert':
      return { ...none, insertQuads: readGraphInsertQuads(target.readGraph, write.quads.filter((quad) => members.has(quad.graph))) };
    case 'delete': {
      const quads = write.quads.filter((quad) => members.has(quad.graph));
      return orReference(() => ({ ...none, after: listOf(readGraphDeltaDelete(target, quads, render)) }), () => reference(touched));
    }
    case 'delete-matching':
      return orReference(() => ({ ...none, before: [readGraphDeltaDeleteMatching(target, write.graph, write.pattern, render)] }),
        () => reference(touched));
    case 'delete-prefix':
      return { ...none, before: [readGraphDeltaDeleteBySubjectPrefix(target, write.graph, write.prefix, render)] };
    case 'replace':
      return reference(write.dropped ? [] : touched);
    case 'replace-subject': {
      const change = reference(touched, write.subject);
      const companions = [...new Set(write.companions ?? [])].filter((subject) => subject !== write.subject);
      return {
        ...change,
        after: [...change.after, ...companions.map((subject) => readGraphCopy(target.readGraph, write.graph, { subject, render }))],
      };
    }
  }
}

/** Join the changes of several read graphs into one write's quads and operations. */
export function joinReadGraphWriteChanges(changes: readonly ReadGraphWriteChange[]): ReadGraphWriteChange {
  return {
    insertQuads: changes.flatMap((change) => change.insertQuads),
    before: changes.flatMap((change) => change.before),
    after: changes.flatMap((change) => change.after),
  };
}

function orReference(delta: () => ReadGraphWriteChange, reference: () => ReadGraphWriteChange): ReadGraphWriteChange {
  try {
    return delta();
  } catch (error) {
    if (error instanceof ReadGraphDeltaFormError) return reference();
    throw error;
  }
}

function listOf(operation: string | undefined): string[] {
  return operation === undefined ? [] : [operation];
}
