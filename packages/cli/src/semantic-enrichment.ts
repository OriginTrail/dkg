export const SEMANTIC_ENRICHMENT_EXTRACTOR_VERSION = 'openclaw-semantic-v1';

export type SemanticEnrichmentKind = 'chat_turn' | 'file_import';
export type SemanticEnrichmentStatus = 'pending' | 'leased' | 'completed' | 'dead_letter';

export interface SemanticEnrichmentDescriptor {
  eventId: string;
  status: SemanticEnrichmentStatus;
  semanticTripleCount: number;
  updatedAt: string;
  lastError?: string;
}

export interface ChatTurnSemanticEventPayload {
  kind: 'chat_turn';
  sessionId: string;
  turnId: string;
  contextGraphId: string;
  assertionName: string;
  assertionUri: string;
  sessionUri: string;
  turnUri: string;
  userMessage: string;
  assistantReply: string;
  attachmentRefs?: unknown[];
  persistenceState: 'stored' | 'failed' | 'pending';
  failureReason?: string;
  projectContextGraphId?: string;
}

export interface FileImportSemanticEventPayload {
  kind: 'file_import';
  contextGraphId: string;
  assertionName: string;
  assertionUri: string;
  importStartedAt: string;
  sourceAgentAddress?: string;
  rootEntity?: string;
  fileHash: string;
  mdIntermediateHash?: string;
  detectedContentType: string;
  sourceFileName?: string;
  ontologyRef?: string;
}

export type SemanticEnrichmentEventPayload =
  | ChatTurnSemanticEventPayload
  | FileImportSemanticEventPayload;

export interface SemanticTripleInput {
  subject: string;
  predicate: string;
  object: string;
}

export function buildChatSemanticIdempotencyKey(turnId: string, payloadHash?: string): string {
  return `chat:${turnId}${payloadHash ? `|${payloadHash}` : ''}`;
}

export function buildFileSemanticIdempotencyKey(args: {
  assertionUri: string;
  importStartedAt: string;
  fileHash: string;
  mdIntermediateHash?: string;
  ontologyRef?: string;
  extractorVersion?: string;
}): string {
  const version = args.extractorVersion ?? SEMANTIC_ENRICHMENT_EXTRACTOR_VERSION;
  return [
    'file',
    args.assertionUri,
    args.importStartedAt,
    args.fileHash,
    args.mdIntermediateHash ?? 'none',
    args.ontologyRef?.trim() || 'none',
    version,
  ].join('|');
}

export function contextGraphOntologyUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_ontology`;
}
