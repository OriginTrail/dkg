import {
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  sharedMemoryReadBothFilter,
} from './constants.js';
import { isDkgContentHash } from './imported-artifact-bytes.js';

const DKG_ONTOLOGY = 'http://dkg.io/ontology/';

export type ImportedArtifactMetadataSource = 'durable' | 'shared-memory';

export interface ImportedArtifactMetadata {
  source: ImportedArtifactMetadataSource;
  sourceFileHash: string;
  sourceContentType: string;
  extractionStatus: 'completed';
  extractionMethod?: string;
  rootEntity?: string;
  sourceFileName?: string;
  structuralTripleCount?: number;
  semanticTripleCount?: number;
  mdIntermediateHash?: string;
  markdownForm?: string;
  markdownHash?: string;
}

export class ImportedArtifactMetadataError extends Error {
  constructor(
    readonly code: 'not_found' | 'incomplete' | 'invalid_metadata' | 'hash_mismatch',
    message: string,
  ) {
    super(message);
  }
}

export interface ResolveImportedArtifactMetadataParams {
  contextGraphId: string;
  assertionUri: string;
  subGraphName?: string;
  requestedFileHash?: string;
  allowSharedMemoryFallback?: boolean;
  fallbackDetectedContentType?: string;
  query: (sparql: string) => Promise<{ type?: string; bindings?: Array<Record<string, unknown>> }>;
}

export async function resolveImportedArtifactMetadata(
  params: ResolveImportedArtifactMetadataParams,
): Promise<ImportedArtifactMetadata> {
  const durable = await resolveDurableImportedArtifactMetadata(params);
  if (durable) return durable;
  if (params.allowSharedMemoryFallback) {
    const swm = await resolveSharedMemoryImportedArtifactMetadata(params);
    if (swm) return swm;
  }
  throw new ImportedArtifactMetadataError('not_found', 'No completed import metadata found for assertionUri');
}

function bindingCellValue(cell: unknown): string {
  if (typeof cell === 'string') return cell.replace(/^<|>$/g, '');
  if (cell && typeof cell === 'object' && 'value' in cell) {
    const value = (cell as { value?: unknown }).value;
    return typeof value === 'string' ? value.replace(/^<|>$/g, '') : '';
  }
  return '';
}

function normalizeLiteral(cell: unknown): string {
  const value = bindingCellValue(cell);
  return value.replace(/^"|"$/g, '').replace(/\^\^<[^>]+>$/, '').trim();
}

function normalizeIri(cell: unknown): string {
  return bindingCellValue(cell).trim();
}

function normalizeContentType(contentType: string | undefined): string {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : 'application/octet-stream';
}

function optionalPositiveInteger(cell: unknown): number | undefined {
  const value = normalizeLiteral(cell);
  if (!/^\+?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function singletonMetadataBinding(
  bindings: Array<Record<string, unknown>>,
  key: string,
  normalize: (cell: unknown) => string,
  label: string,
): string {
  const values = [...new Set(bindings.map((binding) => normalize(binding[key])).filter(Boolean))];
  if (values.length > 1) {
    throw new ImportedArtifactMetadataError('invalid_metadata', `Import metadata contains conflicting ${label} values`);
  }
  return values[0] ?? '';
}

function hashFromFileUrn(value: string | undefined): string | undefined {
  const prefix = 'urn:dkg:file:';
  if (!value?.startsWith(prefix)) return undefined;
  const hash = value.slice(prefix.length);
  return isDkgContentHash(hash) ? hash : undefined;
}

function validateSourceHash(hash: string, requestedFileHash?: string): void {
  if (!hash || !isDkgContentHash(hash)) {
    throw new ImportedArtifactMetadataError('invalid_metadata', 'Import metadata is missing a valid source file hash');
  }
  if (requestedFileHash && requestedFileHash !== hash) {
    throw new ImportedArtifactMetadataError('hash_mismatch', 'fileHash does not match import metadata');
  }
}

function validateMarkdownHash(hash: string | undefined): void {
  if (hash && !isDkgContentHash(hash)) {
    throw new ImportedArtifactMetadataError('invalid_metadata', 'Import metadata is missing a valid Markdown intermediate hash');
  }
}

async function resolveDurableImportedArtifactMetadata(
  params: ResolveImportedArtifactMetadataParams,
): Promise<ImportedArtifactMetadata | undefined> {
  const metaGraph = contextGraphMetaUri(params.contextGraphId);
  const metaResult = await params.query(`
    SELECT ?fileHash ?contentType ?rootEntity ?structuralTripleCount ?semanticTripleCount ?extractionMethod ?extractionStatus ?mdIntermediateHash ?sourceFileName WHERE {
      GRAPH <${metaGraph}> {
        <${params.assertionUri}> <${DKG_ONTOLOGY}sourceFileHash> ?fileHash .
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}sourceContentType> ?contentType }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}rootEntity> ?rootEntity }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}structuralTripleCount> ?structuralTripleCount }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}semanticTripleCount> ?semanticTripleCount }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}extractionMethod> ?extractionMethod }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}extractionStatus> ?extractionStatus }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}mdIntermediateHash> ?mdIntermediateHash }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}sourceFileName> ?sourceFileName }
      }
    }
    LIMIT 1
  `);
  const metaBinding = metaResult.bindings?.[0];
  if (!metaBinding) return undefined;

  const durableExtractionStatus = normalizeLiteral(metaBinding.extractionStatus) || undefined;
  const structuralTripleCount = optionalPositiveInteger(metaBinding.structuralTripleCount);
  if (durableExtractionStatus && durableExtractionStatus !== 'completed') {
    throw new ImportedArtifactMetadataError(
      'incomplete',
      `Import artifact is not a completed extraction (status: ${durableExtractionStatus})`,
    );
  }
  if (!durableExtractionStatus && (structuralTripleCount ?? 0) <= 0) {
    throw new ImportedArtifactMetadataError('incomplete', 'Import metadata is missing completed extraction status');
  }

  const sourceFileHash = normalizeLiteral(metaBinding.fileHash);
  validateSourceHash(sourceFileHash, params.requestedFileHash);

  const durableSourceContentType = normalizeLiteral(metaBinding.contentType) || undefined;
  const sourceContentType = normalizeContentType(durableSourceContentType || params.fallbackDetectedContentType);
  const mdIntermediateHash = normalizeLiteral(metaBinding.mdIntermediateHash) || undefined;
  validateMarkdownHash(mdIntermediateHash);

  const authoritativeMarkdownHash = mdIntermediateHash
    ?? (durableSourceContentType && normalizeContentType(durableSourceContentType) === 'text/markdown'
      ? sourceFileHash
      : undefined);
  await assertDurableMarkdownFormsMatch(params, authoritativeMarkdownHash);

  return {
    source: 'durable',
    sourceFileHash,
    sourceContentType,
    extractionStatus: 'completed',
    extractionMethod: normalizeLiteral(metaBinding.extractionMethod) || undefined,
    rootEntity: normalizeIri(metaBinding.rootEntity) || undefined,
    sourceFileName: normalizeLiteral(metaBinding.sourceFileName) || undefined,
    structuralTripleCount,
    semanticTripleCount: optionalPositiveInteger(metaBinding.semanticTripleCount),
    ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    ...(authoritativeMarkdownHash ? { markdownForm: `urn:dkg:file:${authoritativeMarkdownHash}` } : {}),
    ...(authoritativeMarkdownHash ? { markdownHash: authoritativeMarkdownHash } : {}),
  };
}

async function assertDurableMarkdownFormsMatch(
  params: ResolveImportedArtifactMetadataParams,
  authoritativeMarkdownHash: string | undefined,
): Promise<void> {
  const markdownFormResult = await params.query(`
    SELECT DISTINCT ?markdownForm WHERE {
      GRAPH <${params.assertionUri}> {
        ?document <${DKG_ONTOLOGY}markdownForm> ?markdownForm .
      }
    }
  `);
  const graphMarkdownForms = (markdownFormResult.bindings ?? [])
    .map((binding) => normalizeIri(binding.markdownForm))
    .filter(Boolean);
  for (const graphMarkdownForm of graphMarkdownForms) {
    const markdownFormHash = hashFromFileUrn(graphMarkdownForm);
    if (!markdownFormHash || !authoritativeMarkdownHash || markdownFormHash !== authoritativeMarkdownHash) {
      throw new ImportedArtifactMetadataError(
        'invalid_metadata',
        'Import metadata markdown hash does not match assertion markdownForm',
      );
    }
  }
}

async function resolveSharedMemoryImportedArtifactMetadata(
  params: ResolveImportedArtifactMetadataParams,
): Promise<ImportedArtifactMetadata | undefined> {
  const swmGraph = contextGraphSharedMemoryUri(params.contextGraphId, params.subGraphName);
  const result = await params.query(`
    SELECT ?sourceFile ?contentType ?rootEntity ?markdownForm WHERE {
      GRAPH ?g {
        <${params.assertionUri}> <${DKG_ONTOLOGY}sourceFile> ?sourceFile .
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}sourceContentType> ?contentType }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}rootEntity> ?rootEntity }
        OPTIONAL { <${params.assertionUri}> <${DKG_ONTOLOGY}markdownForm> ?markdownForm }
      }
      ${sharedMemoryReadBothFilter(swmGraph)}
    }
  `);
  const bindings = result.bindings ?? [];
  if (bindings.length === 0) return undefined;

  const sourceFile = singletonMetadataBinding(bindings, 'sourceFile', normalizeIri, 'source file');
  const sourceFileHash = hashFromFileUrn(sourceFile);
  validateSourceHash(sourceFileHash ?? '', params.requestedFileHash);

  const durableSourceContentType = singletonMetadataBinding(
    bindings,
    'contentType',
    normalizeLiteral,
    'source content type',
  ) || undefined;
  const sourceContentType = normalizeContentType(durableSourceContentType || params.fallbackDetectedContentType);
  const rootEntity = singletonMetadataBinding(bindings, 'rootEntity', normalizeIri, 'root entity') || undefined;
  const markdownFormValue = singletonMetadataBinding(bindings, 'markdownForm', normalizeIri, 'Markdown form') || undefined;
  const markdownFormHash = hashFromFileUrn(markdownFormValue);
  if (markdownFormValue) validateMarkdownHash(markdownFormHash);
  const markdownHash = markdownFormHash
    ?? (sourceContentType === 'text/markdown' ? sourceFileHash : undefined);

  return {
    source: 'shared-memory',
    sourceFileHash: sourceFileHash!,
    sourceContentType,
    extractionStatus: 'completed',
    extractionMethod: 'structural',
    ...(rootEntity ? { rootEntity } : {}),
    ...(markdownHash && markdownHash !== sourceFileHash ? { mdIntermediateHash: markdownHash } : {}),
    ...(markdownHash ? { markdownForm: `urn:dkg:file:${markdownHash}` } : {}),
    ...(markdownHash ? { markdownHash } : {}),
  };
}
