/**
 * Pluggable extraction pipeline interface for converting non-RDF files
 * (PDF, DOCX, etc.) into Markdown intermediates and RDF triples.
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

export interface ExtractionOutput {
  /** Markdown intermediate (stored alongside original, inspectable). */
  mdIntermediate: string;
  /** Extracted RDF triples. */
  triples: Quad[];
  /** dkg:ExtractionProvenance quads for semantically extracted triples. */
  provenance: Quad[];
}

export interface ExtractionPipeline {
  /** MIME content types this pipeline handles. */
  readonly contentTypes: string[];
  /** Convert a file to Markdown intermediate + RDF triples. */
  extract(input: ExtractionInput): Promise<ExtractionOutput>;
}

/**
 * Registry that maps content types to extraction pipelines.
 * Nodes register pipelines at startup; the import-file endpoint
 * looks up the pipeline for the detected content type.
 */
export class ExtractionPipelineRegistry {
  private readonly pipelines = new Map<string, ExtractionPipeline>();

  register(pipeline: ExtractionPipeline): void {
    for (const ct of pipeline.contentTypes) {
      this.pipelines.set(ct, pipeline);
    }
  }

  get(contentType: string): ExtractionPipeline | undefined {
    return this.pipelines.get(contentType);
  }

  has(contentType: string): boolean {
    return this.pipelines.has(contentType);
  }

  availableContentTypes(): string[] {
    return [...this.pipelines.keys()];
  }
}
