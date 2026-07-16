import { describe, expect, it } from 'vitest';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import {
  buildSubGraphQuads,
  buildTestQuads,
} from '../e2e/helpers/devnet-publish.js';

describe('devnet publish fixture graph placement', () => {
  it('uses the canonical root context-graph data URI', () => {
    const quads = buildTestQuads('devnet-test', 1, 'Root fixture');

    expect(quads.map((quad) => quad.graph)).toEqual([
      contextGraphDataUri('devnet-test'),
      contextGraphDataUri('devnet-test'),
    ]);
  });

  it('uses the canonical named subgraph data URI', () => {
    const quads = buildSubGraphQuads(
      'devnet-test',
      'e2e-seed-people',
      1,
      'Subgraph fixture',
    );

    expect(quads.map((quad) => quad.graph)).toEqual([
      contextGraphDataUri('devnet-test', 'e2e-seed-people'),
      contextGraphDataUri('devnet-test', 'e2e-seed-people'),
    ]);
  });
});
