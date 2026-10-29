import { describe, expect, it } from 'vitest';
import {
  contextGraphMetadataGraphs,
  contextGraphMetadataHomeGraph,
} from '../src/context-graph-metadata-placement.js';

const ONTOLOGY = 'did:dkg:context-graph:ontology';
const META = 'did:dkg:context-graph:team-a/_meta';

describe('context graph metadata placement', () => {
  it('homes a public graph’s metadata in ontology and a curated graph’s in its own _meta', () => {
    expect(contextGraphMetadataHomeGraph('team-a', { curated: false })).toBe(ONTOLOGY);
    expect(contextGraphMetadataHomeGraph('team-a', { curated: true })).toBe(META);
  });

  it('keeps a copy in _meta for a public graph and never writes a curated graph to ontology', () => {
    expect(contextGraphMetadataGraphs('team-a', { curated: false })).toEqual([ONTOLOGY, META]);
    expect(contextGraphMetadataGraphs('team-a', { curated: true })).toEqual([META]);
  });
});
