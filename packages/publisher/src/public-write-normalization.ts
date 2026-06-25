import {
  normalizeLargeRdfLiteralsForBlazegraph,
  type QuadLiteralLike,
  type RdfLiteralNormalizationOptions,
  type RdfTextLiteralRewrite,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { isBlankNode, isSkolemizedUri, rootEntityFromSkolemized } from './skolemize.js';

const GENID_SEGMENT = '/.well-known/genid/';

export interface PreparedPublicWriteQuads {
  readonly quads: Quad[];
  readonly rewrites: RdfTextLiteralRewrite[];
}

export interface PublicWriteNormalizationOptions extends RdfLiteralNormalizationOptions {
  readonly skolemize?: boolean;
}

export function preparePublicWriteQuads(
  quads: readonly QuadLiteralLike[],
  options: PublicWriteNormalizationOptions = {},
): PreparedPublicWriteQuads {
  const concreteQuads = quads.map(toPublicWriteQuad);
  const input = options.skolemize === false
    ? concreteQuads
    : skolemizePublicWriteQuads(concreteQuads);
  const result = normalizeLargeRdfLiteralsForBlazegraph(input, options);
  return {
    quads: result.quads.map(toPublicWriteQuad),
    rewrites: result.rewrites,
  };
}

function skolemizePublicWriteQuads(quads: readonly Quad[]): Quad[] {
  const blankToRoot = inferBlankNodeRoots(quads);
  return quads.map((quad) => {
    const root = rootForQuad(quad, blankToRoot);
    if (!root) return { ...quad };
    return {
      subject: skolemizeTermForRoot(quad.subject, root),
      predicate: quad.predicate,
      object: skolemizeTermForRoot(quad.object, root),
      graph: quad.graph,
    };
  });
}

function inferBlankNodeRoots(quads: readonly Quad[]): Map<string, string> {
  const blankToRoot = new Map<string, string>();
  for (const quad of quads) {
    const root = rootForNonBlankSubject(quad.subject);
    if (root && isBlankNode(quad.object) && !blankToRoot.has(quad.object)) {
      blankToRoot.set(quad.object, root);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const quad of quads) {
      const root = isBlankNode(quad.subject) ? blankToRoot.get(quad.subject) : undefined;
      if (root && isBlankNode(quad.object) && !blankToRoot.has(quad.object)) {
        blankToRoot.set(quad.object, root);
        changed = true;
      }
    }
  }
  return blankToRoot;
}

function rootForQuad(quad: Quad, blankToRoot: ReadonlyMap<string, string>): string | undefined {
  if (isBlankNode(quad.subject)) return blankToRoot.get(quad.subject);
  return rootForNonBlankSubject(quad.subject);
}

function rootForNonBlankSubject(subject: string): string | undefined {
  if (isBlankNode(subject)) return undefined;
  if (isSkolemizedUri(subject)) return rootEntityFromSkolemized(subject) ?? undefined;
  return subject;
}

function skolemizeTermForRoot(term: string, root: string): string {
  return isBlankNode(term) ? `${root}${GENID_SEGMENT}${term.slice(2)}` : term;
}

export function toPublicWriteQuad(quad: QuadLiteralLike): Quad {
  return {
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    graph: quad.graph ?? '',
  };
}
