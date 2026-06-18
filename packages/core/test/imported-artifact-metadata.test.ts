import { describe, expect, it } from 'vitest';
import {
  ImportedArtifactMetadataError,
  resolveImportedArtifactMetadata,
} from '../src/index.js';

const contextGraphId = '0x0000000000000000000000000000000000000001/research';
const assertionUri = `did:dkg:context-graph:${contextGraphId}/assertion/0x0000000000000000000000000000000000000001/imported`;
const sourceHash = `keccak256:${'a'.repeat(64)}`;
const markdownHash = `keccak256:${'b'.repeat(64)}`;

describe('imported artifact metadata resolver', () => {
  it('resolves durable metadata and validates assertion markdownForm consistency', async () => {
    const metadata = await resolveImportedArtifactMetadata({
      contextGraphId,
      assertionUri,
      query: async (sparql) => {
        if (sparql.includes('/_meta')) {
          return {
            bindings: [{
              fileHash: sourceHash,
              contentType: 'application/pdf; charset=utf-8',
              extractionStatus: 'completed',
              structuralTripleCount: '3',
              semanticTripleCount: '2',
              mdIntermediateHash: markdownHash,
            }],
          };
        }
        if (sparql.includes('markdownForm')) {
          return { bindings: [{ markdownForm: `urn:dkg:file:${markdownHash}` }] };
        }
        return { bindings: [] };
      },
    });

    expect(metadata).toMatchObject({
      source: 'durable',
      sourceFileHash: sourceHash,
      sourceContentType: 'application/pdf',
      structuralTripleCount: 3,
      semanticTripleCount: 2,
      mdIntermediateHash: markdownHash,
      markdownHash,
      markdownForm: `urn:dkg:file:${markdownHash}`,
    });
  });

  it('rejects durable metadata when assertion markdownForm points at a different hash', async () => {
    await expect(resolveImportedArtifactMetadata({
      contextGraphId,
      assertionUri,
      query: async (sparql) => {
        if (sparql.includes('/_meta')) {
          return {
            bindings: [{
              fileHash: sourceHash,
              contentType: 'application/pdf',
              extractionStatus: 'completed',
              structuralTripleCount: '3',
              mdIntermediateHash: markdownHash,
            }],
          };
        }
        return { bindings: [{ markdownForm: `urn:dkg:file:keccak256:${'c'.repeat(64)}` }] };
      },
    })).rejects.toMatchObject({
      code: 'invalid_metadata',
      message: 'Import metadata markdown hash does not match assertion markdownForm',
    } satisfies Partial<ImportedArtifactMetadataError>);
  });

  it('falls back to shared-memory metadata when durable metadata is absent', async () => {
    const metadata = await resolveImportedArtifactMetadata({
      contextGraphId,
      assertionUri,
      allowSharedMemoryFallback: true,
      query: async (sparql) => {
        if (sparql.includes('/_meta')) return { bindings: [] };
        return {
          bindings: [{
            sourceFile: `urn:dkg:file:${sourceHash}`,
            contentType: 'text/markdown',
          }],
        };
      },
    });

    expect(metadata).toMatchObject({
      source: 'shared-memory',
      sourceFileHash: sourceHash,
      sourceContentType: 'text/markdown',
      extractionStatus: 'completed',
      extractionMethod: 'structural',
      markdownHash: sourceHash,
      markdownForm: `urn:dkg:file:${sourceHash}`,
    });
  });
});
