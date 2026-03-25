export { default as createHandler } from './api/handler.js';
export type { AppRequestHandler } from './api/handler.js';

// RDF transformer
export {
  transformRepository,
  transformUser,
  transformPullRequest,
  transformPullRequestFiles,
  transformReview,
  transformReviewComment,
  transformIssue,
  transformIssueComment,
  transformCommit,
  transformLabel,
  transformMilestone,
  transformBranch,
} from './rdf/transformer.js';

// URI helpers
export {
  GH, RDF, XSD, PROV, RDFS,
  repoUri, userUri, prUri, issueUri, commitUri, branchUri,
  reviewUri, reviewCommentUri, issueCommentUri, labelUri, milestoneUri, fileDiffUri,
  fileUri, directoryUri,
  paranetId, generateParanetSuffix,
} from './rdf/uri.js';
export type { Quad } from './rdf/uri.js';

// Code transformer
export { transformFileTree, transformCodeEntities, transformRelationships, detectLanguage } from './rdf/code-transformer.js';
export type { GitTreeEntry, ResolvedRelationship } from './rdf/code-transformer.js';

// Code sync
export { CodeSync } from './github/code-sync.js';
export type { CodeSyncOptions, CodeSyncResult, CodeEntitySyncResult, CodeSyncProgress } from './github/code-sync.js';

// Code parsers
export { TypeScriptParser } from './code/typescript-parser.js';
export { TreeSitterParser } from './code/tree-sitter-parser.js';
export { getParser, isParseable, PARSEABLE_EXTENSIONS } from './code/parser-registry.js';
export type { LanguageParser, ParseResult, ParsedEntity, ParsedImport, ParsedExport } from './code/parser.js';

// Relationship extractor
export { buildFileIndex, extractRelationships } from './code/relationship-extractor.js';
export type { ParsedFileIndex } from './code/relationship-extractor.js';

// GitHub client
export { GitHubClient, GitHubApiError } from './github/client.js';
export type {
  GitHubClientOptions,
  ListPullRequestsOptions,
  ListIssuesOptions,
  ListCommitsOptions,
  PaginationOptions,
  RateLimitInfo,
} from './github/client.js';

// Coordinator
export { GitHubCollabCoordinator } from './dkg/coordinator.js';
export type { RepoConfig, ReviewSession, Invitation, PeerInfo } from './dkg/coordinator.js';

// Sync engine
export { SyncEngine } from './dkg/sync-engine.js';
export type { RepoSyncConfig, SyncScope, SyncJob, WebhookResult } from './dkg/sync-engine.js';

// Protocol
export { APP_ID, encodeMessage, decodeMessage } from './dkg/protocol.js';
export type { AppMessage, MessageType } from './dkg/protocol.js';
