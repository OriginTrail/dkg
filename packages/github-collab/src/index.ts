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
  paranetId, generateParanetSuffix,
} from './rdf/uri.js';
export type { Quad } from './rdf/uri.js';

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
