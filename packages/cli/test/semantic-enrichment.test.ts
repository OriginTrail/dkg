import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_ENRICHMENT_EXTRACTOR_VERSION,
  buildFileSemanticIdempotencyKey,
  contextGraphOntologyUri,
} from '../src/semantic-enrichment.js';

describe('semantic enrichment helpers', () => {
  it('keys file imports by assertion, import instance, ontology override, and extractor version', () => {
    const baseArgs = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/peer/roadmap',
      importStartedAt: '2026-04-15T10:00:00.000Z',
      fileHash: 'keccak256:file-1',
      mdIntermediateHash: 'keccak256:md-1',
    };

    const baseKey = buildFileSemanticIdempotencyKey(baseArgs);
    expect(baseKey).toBe([
      'file',
      baseArgs.assertionUri,
      baseArgs.importStartedAt,
      baseArgs.fileHash,
      baseArgs.mdIntermediateHash,
      'none',
      SEMANTIC_ENRICHMENT_EXTRACTOR_VERSION,
    ].join('|'));

    expect(buildFileSemanticIdempotencyKey({
      ...baseArgs,
      ontologyRef: 'did:dkg:context-graph:project-1/custom-ontology',
    })).not.toBe(baseKey);

    expect(buildFileSemanticIdempotencyKey({
      ...baseArgs,
      importStartedAt: '2026-04-15T10:05:00.000Z',
    })).not.toBe(baseKey);
  });

  it('derives the canonical project ontology graph URI', () => {
    expect(contextGraphOntologyUri('project-42')).toBe('did:dkg:context-graph:project-42/_ontology');
  });
});
