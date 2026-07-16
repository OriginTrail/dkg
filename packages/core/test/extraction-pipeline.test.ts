import { describe, it, expect } from 'vitest';
import {
  ExtractionPipelineRegistry,
  type ExtractionPipeline,
  type ExtractionInput,
  type ConverterOutput,
} from '../src/extraction-pipeline.js';

function makePipeline(contentTypes: string[], output?: Partial<ConverterOutput>): ExtractionPipeline {
  return {
    contentTypes,
    async extract(_input: ExtractionInput): Promise<ConverterOutput> {
      return {
        mdIntermediate: output?.mdIntermediate ?? '# Test',
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

  it('normalizes casing and media-type parameters on registration and lookup', () => {
    const registry = new ExtractionPipelineRegistry();
    const pipeline = makePipeline(['Application/PDF']);
    registry.register(pipeline);

    expect(registry.has('application/pdf')).toBe(true);
    expect(registry.get('APPLICATION/PDF; charset=utf-8')).toBe(pipeline);
    expect(registry.availableContentTypes()).toEqual(['application/pdf']);
  });
});

describe('ExtractionPipeline interface (Phase 1 converter)', () => {
  it('extract returns ConverterOutput with mdIntermediate only', async () => {
    const pipeline = makePipeline(['text/markdown'], {
      mdIntermediate: '# Hello\n\nWorld',
    });

    const result = await pipeline.extract({
      filePath: '/tmp/test.md',
      contentType: 'text/markdown',
      agentDid: 'did:dkg:agent:0x123',
    });

    expect(result.mdIntermediate).toBe('# Hello\n\nWorld');
    // Converter output must not carry triples/provenance — those come from Phase 2.
    expect((result as { triples?: unknown }).triples).toBeUndefined();
    expect((result as { provenance?: unknown }).provenance).toBeUndefined();
  });

  it('extract passes through ontologyRef when provided', async () => {
    let capturedInput: ExtractionInput | null = null;
    const pipeline: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(input) {
        capturedInput = input;
        return { mdIntermediate: '' };
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
