import { describe, expect, it } from 'vitest';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { buildSubGraphQuads, buildTestQuads } from '../e2e/helpers/devnet-publish.js';

describe('devnet publish fixture graph placement', () => {
  it('uses canonical physical data graph URIs for root and named sub-graph seeds', () => {
    expect(buildTestQuads('music-social', 1, 'root')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ graph: contextGraphDataUri('music-social') }),
      ]),
    );
    expect(buildSubGraphQuads('music-social', 'artists', 2, 'subgraph')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ graph: contextGraphDataUri('music-social', 'artists') }),
      ]),
    );
  });
});
