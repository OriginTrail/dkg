import { describe, it, expect } from 'vitest';
import {
  ExtractionPipelineRegistry,
  type ExtractionPipeline,
  type ExtractionInput,
  type ExtractionOutput,
} from '../src/extraction-pipeline.js';

function makePipeline(contentTypes: string[], output?: Partial<ExtractionOutput>): ExtractionPipeline {
  return {
    contentTypes,
    async extract(_input: ExtractionInput): Promise<ExtractionOutput> {
      return {
        mdIntermediate: output?.mdIntermediate ?? '# Test',
        triples: output?.triples ?? [],
        provenance: output?.provenance ?? [],
      };
    },
  };
}

describe('ExtractionPipelineRegistry', () => {
  it('starts empty', () => {
    const registry = new ExtractionPipelineRegistry();
    expect(registry.availableContentTypes()).toEqual([]);
    expect(registry.has('text/markdown')).toBe(false);
    expect(registry.get('text/markdown')).toBeUndefined();
  });

  it('registers a pipeline for its content types', () => {
    const registry = new ExtractionPipelineRegistry();
    const pipeline = makePipeline(['application/pdf', 'text/html']);
    registry.register(pipeline);

    expect(registry.has('application/pdf')).toBe(true);
    expect(registry.has('text/html')).toBe(true);
    expect(registry.has('text/plain')).toBe(false);
    expect(registry.get('application/pdf')).toBe(pipeline);
    expect(registry.get('text/html')).toBe(pipeline);
  });

  it('lists all available content types', () => {
    const registry = new ExtractionPipelineRegistry();
    registry.register(makePipeline(['text/markdown']));
    registry.register(makePipeline(['application/pdf', 'text/csv']));

    const types = registry.availableContentTypes();
    expect(types).toContain('text/markdown');
    expect(types).toContain('application/pdf');
    expect(types).toContain('text/csv');
    expect(types).toHaveLength(3);
  });

  it('later registration overwrites earlier for same content type', () => {
    const registry = new ExtractionPipelineRegistry();
    const first = makePipeline(['application/pdf']);
    const second = makePipeline(['application/pdf']);
    registry.register(first);
    registry.register(second);

    expect(registry.get('application/pdf')).toBe(second);
  });

  it('supports multiple pipelines for different types', () => {
    const registry = new ExtractionPipelineRegistry();
    const mdPipeline = makePipeline(['text/markdown']);
    const pdfPipeline = makePipeline(['application/pdf']);
    registry.register(mdPipeline);
    registry.register(pdfPipeline);

    expect(registry.get('text/markdown')).toBe(mdPipeline);
    expect(registry.get('application/pdf')).toBe(pdfPipeline);
  });
});

describe('ExtractionPipeline interface', () => {
  it('extract returns mdIntermediate, triples, and provenance', async () => {
    const pipeline = makePipeline(['text/markdown'], {
      mdIntermediate: '# Hello\n\nWorld',
      triples: [{ subject: 'urn:test:1', predicate: 'rdf:type', object: 'schema:Thing' }],
      provenance: [{ subject: 'urn:prov:1', predicate: 'dkg:extractedBy', object: 'did:dkg:agent:0x123' }],
    });

    const result = await pipeline.extract({
      filePath: '/tmp/test.md',
      contentType: 'text/markdown',
      agentDid: 'did:dkg:agent:0x123',
    });

    expect(result.mdIntermediate).toBe('# Hello\n\nWorld');
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe('urn:test:1');
    expect(result.provenance).toHaveLength(1);
  });

  it('extract passes through ontologyRef when provided', async () => {
    let capturedInput: ExtractionInput | null = null;
    const pipeline: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(input) {
        capturedInput = input;
        return { mdIntermediate: '', triples: [], provenance: [] };
      },
    };

    await pipeline.extract({
      filePath: '/tmp/paper.pdf',
      contentType: 'application/pdf',
      agentDid: 'did:dkg:agent:0xAbc',
      ontologyRef: 'did:dkg:context-graph:research/_ontology',
    });

    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.ontologyRef).toBe('did:dkg:context-graph:research/_ontology');
    expect(capturedInput!.agentDid).toBe('did:dkg:agent:0xAbc');
  });
});
