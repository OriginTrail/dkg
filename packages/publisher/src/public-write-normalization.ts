import {
  normalizeLargeRdfLiteralsForBlazegraph,
  type QuadLiteralLike,
  type RdfLiteralNormalizationOptions,
  type RdfTextLiteralRewrite,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { skolemizeByEntity } from './auto-partition.js';

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
  const skolemizedByRoot = options.skolemize === false
    ? new Map<string, Quad[]>()
    : skolemizeByEntity(concreteQuads);
  const input = skolemizedByRoot.size > 0
    ? [...skolemizedByRoot.values()].flat()
    : concreteQuads;
  const result = normalizeLargeRdfLiteralsForBlazegraph(input, options);
  return {
    quads: result.quads.map(toPublicWriteQuad),
    rewrites: result.rewrites,
  };
}

export function toPublicWriteQuad(quad: QuadLiteralLike): Quad {
  return {
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    graph: quad.graph ?? '',
  };
}
