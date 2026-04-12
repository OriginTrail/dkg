import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Dynamic import so vi.mock takes effect before module loads
let MarkItDownConverter: typeof import('../src/extraction/markitdown-converter.js').MarkItDownConverter;
let isMarkItDownAvailable: typeof import('../src/extraction/markitdown-converter.js').isMarkItDownAvailable;
let MARKITDOWN_CONTENT_TYPES: typeof import('../src/extraction/markitdown-converter.js').MARKITDOWN_CONTENT_TYPES;

describe('MARKITDOWN_CONTENT_TYPES', () => {
  beforeEach(async () => {
    const mod = await import('../src/extraction/markitdown-converter.js');
    MARKITDOWN_CONTENT_TYPES = mod.MARKITDOWN_CONTENT_TYPES;
  });

  it('includes PDF', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain('application/pdf');
  });

  it('includes DOCX', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('includes PPTX', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('includes XLSX', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('includes CSV and HTML', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain('text/csv');
    expect(MARKITDOWN_CONTENT_TYPES).toContain('text/html');
  });
});

describe('MarkItDownConverter', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/extraction/markitdown-converter.js');
    MarkItDownConverter = mod.MarkItDownConverter;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes all supported content types', () => {
    const converter = new MarkItDownConverter();
    expect(converter.contentTypes).toContain('application/pdf');
    expect(converter.contentTypes).toContain('text/csv');
    expect(converter.contentTypes.length).toBeGreaterThanOrEqual(6);
  });

  it('extract returns ConverterOutput with mdIntermediate only (phase 1)', async () => {
    const converter = new MarkItDownConverter();

    // If markitdown is not available, the extract call should throw
    // with a helpful error message rather than silently failing
    const available = (await import('../src/extraction/markitdown-converter.js')).isMarkItDownAvailable();
    if (!available) {
      await expect(converter.extract({
        filePath: '/tmp/nonexistent.pdf',
        contentType: 'application/pdf',
        agentDid: 'did:dkg:agent:0xAbc',
      })).rejects.toThrow(/MarkItDown binary not found/);
      return;
    }

    // If available, test the actual conversion (only runs if binary is present)
    const tmpDir = await mkdtemp(join(tmpdir(), 'markitdown-test-'));
    const testFile = join(tmpDir, 'test.html');
    await writeFile(testFile, '<html><body><h1>Hello</h1><p>World</p></body></html>');

    try {
      const result = await converter.extract({
        filePath: testFile,
        contentType: 'text/html',
        agentDid: 'did:dkg:agent:0xTest',
      });

      expect(typeof result.mdIntermediate).toBe('string');
      expect(result.mdIntermediate.length).toBeGreaterThan(0);
      // Phase 1 only — converter returns ConverterOutput, no triples
      // or source-file linkage (those are Phase 2 extractor output).
      // Round 13 Bug 39 renamed the linkage field from `provenance`
      // to `sourceFileLinkage` on `MarkdownExtractOutput`; this
      // converter's output has neither.
      expect((result as { triples?: unknown }).triples).toBeUndefined();
      expect((result as { sourceFileLinkage?: unknown }).sourceFileLinkage).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('isMarkItDownAvailable', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/extraction/markitdown-converter.js');
    isMarkItDownAvailable = mod.isMarkItDownAvailable;
  });

  it('returns a boolean', () => {
    const result = isMarkItDownAvailable();
    expect(typeof result).toBe('boolean');
  });
});
