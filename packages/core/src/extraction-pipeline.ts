/**
 * Pluggable extraction pipeline interfaces for the document ingestion flow.
 *
 * Two phases:
 *  - Phase 1 (converter): source file → Markdown intermediate.
 *    Implemented by ExtractionPipeline (e.g. MarkItDownConverter).
 *  - Phase 2 (structural extraction): Markdown intermediate → RDF triples.
 *    Runs directly in the import-file route handler — not through a
 *    pluggable registry. See 19_MARKDOWN_CONTENT_TYPE.md.
 *
 * The route handler orchestrates both phases and returns an
 * ExtractionOutput that composes Phase 1's mdIntermediate with
 * Phase 2's triples and provenance.
 *
 * Spec: 05_PROTOCOL_EXTENSIONS.md §6.5
 */

export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface ExtractionInput {
  /** Path to the file on disk (temp file from multipart upload). */
  filePath: string;
  /** Detected or user-specified MIME content type. */
  contentType: string;
  /** Optional: CG's _ontology graph URI for guided extraction. */
  ontologyRef?: string;
  /** Extracting agent's DID (for provenance tracking). */
  agentDid: string;
}

/**
 * Phase 1 converter output. A converter is responsible ONLY for turning
 * a source file into a Markdown intermediate. It does not produce triples.
 */
export interface ConverterOutput {
  /** Markdown intermediate, stored alongside the original file and inspectable. */
  mdIntermediate: string;
}

/**
 * Composite Phase 1 + Phase 2 result produced by the import-file route
 * handler. `mdIntermediate` is byte-for-byte what the converter returned;
 * `triples` and `provenance` come from the Phase 2 Markdown extractor.
 */
export interface ExtractionOutput {
  mdIntermediate: string;
  triples: Quad[];
  provenance: Quad[];
}

export interface ExtractionPipeline {
  /** MIME content types this converter handles. */
  readonly contentTypes: string[];
  /** Convert a source file into a Markdown intermediate. Phase 1 only. */
  extract(input: ExtractionInput): Promise<ConverterOutput>;
}

function normalizeContentType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * Registry that maps content types to converter pipelines.
 * Nodes register pipelines at startup; the import-file route handler
 * looks up the pipeline for the detected content type and calls its
 * Phase 1 `extract()`. Phase 2 is not registered — the handler runs
 * it directly on the Markdown intermediate.
 */
export class ExtractionPipelineRegistry {
  private readonly pipelines = new Map<string, ExtractionPipeline>();

  register(pipeline: ExtractionPipeline): void {
    for (const ct of pipeline.contentTypes) {
      const normalized = normalizeContentType(ct);
      if (normalized.length === 0) continue;
      this.pipelines.set(normalized, pipeline);
    }
  }

  get(contentType: string): ExtractionPipeline | undefined {
    return this.pipelines.get(normalizeContentType(contentType));
  }

  has(contentType: string): boolean {
    return this.pipelines.has(normalizeContentType(contentType));
  }

  availableContentTypes(): string[] {
    return [...this.pipelines.keys()];
  }
}
