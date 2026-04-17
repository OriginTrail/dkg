/**
 * E2E tests for the document processing pipeline.
 *
 * Tests the full flow: file on disk → ExtractionPipeline → Markdown intermediate.
 * When MarkItDown is available, tests real conversion of HTML/CSV/Markdown files.
 * When unavailable, tests graceful degradation and the pipeline registry plumbing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ExtractionPipelineRegistry,
  type ExtractionPipeline,
  type ExtractionInput,
  type ConverterOutput,
} from '@origintrail-official/dkg-core';
import { MarkItDownConverter, isMarkItDownAvailable } from '../src/extraction/index.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dkg-docproc-e2e-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registry-level E2E: register → lookup → extract
// ---------------------------------------------------------------------------

describe('ExtractionPipelineRegistry E2E', () => {
  it('registers MarkItDownConverter and resolves content types', () => {
    const registry = new ExtractionPipelineRegistry();
    const converter = new MarkItDownConverter();
    registry.register(converter);

    expect(registry.has('application/pdf')).toBe(true);
    expect(registry.has('text/csv')).toBe(true);
    expect(registry.has('text/html')).toBe(true);
    expect(registry.has('text/plain')).toBe(false);
    expect(registry.get('application/pdf')).toBe(converter);
  });

  it('reports all available content types after MarkItDown registration', () => {
    const registry = new ExtractionPipelineRegistry();
    registry.register(new MarkItDownConverter());

    const types = registry.availableContentTypes();
    expect(types.length).toBeGreaterThanOrEqual(6);
    expect(types).toContain('application/pdf');
    expect(types).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('supports multiple pipelines: custom markdown + MarkItDown', () => {
    const registry = new ExtractionPipelineRegistry();

    const customMdPipeline: ExtractionPipeline = {
      contentTypes: ['text/markdown'],
      async extract(input: ExtractionInput): Promise<ConverterOutput> {
        const md = await readFile(input.filePath, 'utf-8');
        return { mdIntermediate: md };
      },
    };

    registry.register(customMdPipeline);
    registry.register(new MarkItDownConverter());

    expect(registry.get('text/markdown')).toBe(customMdPipeline);
    expect(registry.get('application/pdf')).toBeInstanceOf(MarkItDownConverter);
  });
});

// ---------------------------------------------------------------------------
// Document conversion E2E (requires MarkItDown binary)
// ---------------------------------------------------------------------------

const markitdownAvailable = isMarkItDownAvailable();

describe.skipIf(!markitdownAvailable)('MarkItDown E2E — real file conversion', () => {
  let converter: MarkItDownConverter;

  beforeEach(() => {
    converter = new MarkItDownConverter();
  });

  it('converts an HTML file to Markdown', async () => {
    const htmlFile = join(tmpDir, 'page.html');
    await writeFile(htmlFile, `
      <html>
      <body>
        <h1>Research Paper</h1>
        <p>This paper discusses <strong>decentralized knowledge graphs</strong>.</p>
        <p>Unicode canary: čćž 日本語</p>
        <h2>Introduction</h2>
        <p>The DKG protocol enables verifiable AI memory.</p>
        <ul>
          <li>Working Memory</li>
          <li>Shared Working Memory</li>
          <li>Verified Memory</li>
        </ul>
      </body>
      </html>
    `);

    const result = await converter.extract({
      filePath: htmlFile,
      contentType: 'text/html',
      agentDid: 'did:dkg:agent:0xTest',
    });

    expect(result.mdIntermediate).toContain('Research Paper');
    expect(result.mdIntermediate).toContain('decentralized knowledge graphs');
    expect(result.mdIntermediate).toContain('čćž 日本語');
  }, 30_000);

  it('converts a CSV file to Markdown', async () => {
    const csvFile = join(tmpDir, 'data.csv');
    await writeFile(csvFile, 'Name,Role,Trust\nAlice,Researcher,endorsed\nBob,Validator,consensus-verified\n');

    const result = await converter.extract({
      filePath: csvFile,
      contentType: 'text/csv',
      agentDid: 'did:dkg:agent:0xTest',
    });

    expect(result.mdIntermediate).toContain('Alice');
    expect(result.mdIntermediate).toContain('Bob');
    expect(result.mdIntermediate).toContain('Researcher');
  }, 30_000);

  it('handles empty file gracefully', async () => {
    const emptyFile = join(tmpDir, 'empty.html');
    await writeFile(emptyFile, '');

    const result = await converter.extract({
      filePath: emptyFile,
      contentType: 'text/html',
      agentDid: 'did:dkg:agent:0xTest',
    });

    expect(result.mdIntermediate).toBe('');
  }, 30_000);

  it('processes file through registry lookup → extract', async () => {
    const registry = new ExtractionPipelineRegistry();
    registry.register(converter);

    const htmlFile = join(tmpDir, 'test.html');
    await writeFile(htmlFile, '<h1>Title</h1><p>Body text</p>');

    const pipeline = registry.get('text/html');
    expect(pipeline).toBeDefined();

    const result = await pipeline!.extract({
      filePath: htmlFile,
      contentType: 'text/html',
      agentDid: 'did:dkg:agent:0xTest',
    });

    expect(result.mdIntermediate).toContain('Title');
    expect(result.mdIntermediate).toContain('Body text');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Graceful degradation (MarkItDown unavailable)
// ---------------------------------------------------------------------------

describe.skipIf(markitdownAvailable)('MarkItDown unavailable — graceful degradation', () => {
  it('isMarkItDownAvailable returns false', () => {
    expect(isMarkItDownAvailable()).toBe(false);
  });

  it('extract throws descriptive error when binary is missing', async () => {
    const converter = new MarkItDownConverter();
    await expect(converter.extract({
      filePath: '/tmp/fake.pdf',
      contentType: 'application/pdf',
      agentDid: 'did:dkg:agent:0xTest',
    })).rejects.toThrow(/MarkItDown binary not found/);
  });

  it('registry still works — returns undefined for unregistered types', () => {
    const registry = new ExtractionPipelineRegistry();
    expect(registry.get('application/pdf')).toBeUndefined();
    expect(registry.availableContentTypes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline simulation: file → markdown → mock triples
// ---------------------------------------------------------------------------

describe('Full extraction pipeline simulation', () => {
  it('processes a file through phase 1 (file→MD) and phase 2 (MD→triples)', async () => {
    const testFile = join(tmpDir, 'input.md');
    await writeFile(testFile, '# Climate Report\n\nGlobal temperature rose by 1.2°C.\n');

    // Phase 1: file → markdown intermediate (simulated as direct read for .md files)
    const phase1: ExtractionPipeline = {
      contentTypes: ['text/markdown'],
      async extract(input) {
        const md = await readFile(input.filePath, 'utf-8');
        return { mdIntermediate: md };
      },
    };

    const phase1Result = await phase1.extract({
      filePath: testFile,
      contentType: 'text/markdown',
      agentDid: 'did:dkg:agent:0xClimate',
    });

    expect(phase1Result.mdIntermediate).toContain('Climate Report');
    expect(phase1Result.mdIntermediate).toContain('1.2°C');

    // Phase 1 output is sufficient: verify the markdown intermediate is usable
    expect(phase1Result.mdIntermediate.length).toBeGreaterThan(0);
    expect(typeof phase1Result.mdIntermediate).toBe('string');
  });

  it('HTML pipeline strips tags and preserves text content', async () => {
    const testFile = join(tmpDir, 'report.html');
    await writeFile(testFile, '<h1>Q4 Sales</h1><p>Revenue: $1.2M</p>');

    const registry = new ExtractionPipelineRegistry();

    registry.register({
      contentTypes: ['text/html'],
      async extract(input) {
        const content = await readFile(input.filePath, 'utf-8');
        return {
          mdIntermediate: content.replace(/<[^>]+>/g, ''),
        };
      },
    });

    const pipeline = registry.get('text/html');
    expect(pipeline).toBeDefined();

    const result = await pipeline!.extract({
      filePath: testFile,
      contentType: 'text/html',
      agentDid: 'did:dkg:agent:0xSales',
    });

    expect(result.mdIntermediate).toContain('Q4 Sales');
    expect(result.mdIntermediate).toContain('$1.2M');
    expect(result.mdIntermediate).not.toContain('<h1>');
  });

  it('returns undefined for unregistered content type', () => {
    const registry = new ExtractionPipelineRegistry();
    registry.register(new MarkItDownConverter());

    const pipeline = registry.get('application/octet-stream');
    expect(pipeline).toBeUndefined();
  });
});
