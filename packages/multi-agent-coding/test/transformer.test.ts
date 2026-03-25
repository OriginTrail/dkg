/**
 * Unit tests for src/rdf/transformer.ts and src/rdf/uri.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  GH, RDF, XSD, PROV, RDFS,
  repoUri, userUri, prUri, issueUri, commitUri, branchUri,
  reviewUri, reviewCommentUri, issueCommentUri, labelUri, milestoneUri, fileDiffUri,
  paranetId, generateParanetSuffix,
  tripleStr, tripleInt, tripleBool, tripleDateTime, tripleUri, tripleTyped,
  type Quad,
} from '../src/rdf/uri.js';
import {
  transformRepository,
  transformUser,
  transformPullRequest,
  transformReview,
  transformReviewComment,
  transformIssue,
  transformIssueComment,
  transformCommit,
  transformPullRequestFiles,
  transformLabel,
  transformMilestone,
  transformBranch,
} from '../src/rdf/transformer.js';
import {
  sampleRepository,
  samplePullRequest,
  sampleReview,
  sampleIssue,
  sampleCommit,
  sampleUser,
} from './helpers/index.js';

const GRAPH = 'did:dkg:paranet:github-collab:octocat/Hello-World';

/** Find a quad by predicate (and optionally subject). */
function findQuad(quads: Quad[], predicate: string, subject?: string): Quad | undefined {
  return quads.find(q => q.predicate === predicate && (subject === undefined || q.subject === subject));
}

/** Find all quads matching a predicate. */
function findQuads(quads: Quad[], predicate: string, subject?: string): Quad[] {
  return quads.filter(q => q.predicate === predicate && (subject === undefined || q.subject === subject));
}

/** Check a quad has the correct graph. */
function assertGraph(quads: Quad[], graph: string) {
  for (const q of quads) {
    expect(q.graph).toBe(graph);
  }
}

// =========================================================================
// URI Helpers
// =========================================================================

describe('URI helpers', () => {
  it('repoUri follows urn:github:{owner}/{repo} pattern', () => {
    expect(repoUri('octocat', 'Hello-World')).toBe('urn:github:octocat/Hello-World');
  });

  it('userUri follows urn:github:user/{login} pattern', () => {
    expect(userUri('octocat')).toBe('urn:github:user/octocat');
  });

  it('prUri follows urn:github:{owner}/{repo}/pr/{number} pattern', () => {
    expect(prUri('octocat', 'Hello-World', 42)).toBe('urn:github:octocat/Hello-World/pr/42');
  });

  it('issueUri follows urn:github:{owner}/{repo}/issue/{number} pattern', () => {
    expect(issueUri('octocat', 'Hello-World', 10)).toBe('urn:github:octocat/Hello-World/issue/10');
  });

  it('commitUri follows urn:github:{owner}/{repo}/commit/{sha} pattern', () => {
    expect(commitUri('octocat', 'Hello-World', 'abc123')).toBe('urn:github:octocat/Hello-World/commit/abc123');
  });

  it('branchUri follows urn:github:{owner}/{repo}/branch/{name} pattern', () => {
    expect(branchUri('octocat', 'Hello-World', 'main')).toBe('urn:github:octocat/Hello-World/branch/main');
  });

  it('reviewUri follows urn:github:{owner}/{repo}/pr/{number}/review/{id} pattern', () => {
    expect(reviewUri('octocat', 'Hello-World', 42, 100)).toBe('urn:github:octocat/Hello-World/pr/42/review/100');
  });

  it('reviewCommentUri follows correct pattern', () => {
    expect(reviewCommentUri('octocat', 'Hello-World', 42, 200)).toBe('urn:github:octocat/Hello-World/pr/42/comment/200');
  });

  it('issueCommentUri follows correct pattern', () => {
    expect(issueCommentUri('octocat', 'Hello-World', 10, 300)).toBe('urn:github:octocat/Hello-World/issue/10/comment/300');
  });

  it('labelUri encodes special characters', () => {
    expect(labelUri('o', 'r', 'bug fix')).toBe('urn:github:o/r/label/bug%20fix');
    expect(labelUri('o', 'r', 'simple')).toBe('urn:github:o/r/label/simple');
  });

  it('milestoneUri follows correct pattern', () => {
    expect(milestoneUri('octocat', 'Hello-World', 1)).toBe('urn:github:octocat/Hello-World/milestone/1');
  });

  it('fileDiffUri encodes file paths', () => {
    expect(fileDiffUri('o', 'r', 1, 'src/index.ts')).toBe('urn:github:o/r/pr/1/file/src%2Findex.ts');
  });

  it('paranetId follows github-collab:{owner}/{repo} pattern', () => {
    expect(paranetId('octocat', 'Hello-World')).toBe('github-collab:octocat/Hello-World');
  });

  it('paranetId with suffix appends colon-separated suffix', () => {
    expect(paranetId('octocat', 'Hello-World', 'a8f3b2c1')).toBe('github-collab:octocat/Hello-World:a8f3b2c1');
  });

  it('paranetId without suffix omits trailing colon', () => {
    const id = paranetId('octocat', 'Hello-World');
    expect(id).not.toContain('::');
    expect(id.endsWith(':')).toBe(false);
  });

  it('paranetId with undefined suffix behaves like no suffix', () => {
    expect(paranetId('octocat', 'Hello-World', undefined)).toBe('github-collab:octocat/Hello-World');
  });

  it('generateParanetSuffix returns 8-character hex string', () => {
    const suffix = generateParanetSuffix();
    expect(suffix).toHaveLength(8);
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  it('generateParanetSuffix returns different values on each call', () => {
    const suffixes = new Set(Array.from({ length: 10 }, () => generateParanetSuffix()));
    // At least most should be unique (extremely high probability)
    expect(suffixes.size).toBeGreaterThan(5);
  });
});

// =========================================================================
// Quad helpers
// =========================================================================

describe('quad helpers', () => {
  it('tripleStr produces quoted literal', () => {
    const q = tripleStr('urn:s', 'urn:p', 'hello', 'urn:g');
    expect(q.object).toBe('"hello"');
  });

  it('tripleStr escapes special characters', () => {
    const q = tripleStr('urn:s', 'urn:p', 'line1\nline2\twith "quotes" and \\backslash', 'urn:g');
    expect(q.object).toBe('"line1\\nline2\\twith \\"quotes\\" and \\\\backslash"');
  });

  it('tripleInt produces xsd:integer typed literal', () => {
    const q = tripleInt('urn:s', 'urn:p', 42, 'urn:g');
    expect(q.object).toBe(`"42"^^<${XSD}integer>`);
  });

  it('tripleBool produces xsd:boolean typed literal', () => {
    const q = tripleBool('urn:s', 'urn:p', true, 'urn:g');
    expect(q.object).toBe(`"true"^^<${XSD}boolean>`);
  });

  it('tripleDateTime produces xsd:dateTime typed literal', () => {
    const q = tripleDateTime('urn:s', 'urn:p', '2024-01-15T10:00:00Z', 'urn:g');
    expect(q.object).toBe(`"2024-01-15T10:00:00Z"^^<${XSD}dateTime>`);
  });

  it('tripleUri produces a plain URI object', () => {
    const q = tripleUri('urn:s', 'urn:p', 'urn:o', 'urn:g');
    expect(q.object).toBe('urn:o');
    // No quotes wrapping
    expect(q.object.startsWith('"')).toBe(false);
  });

  it('all quad fields are strings', () => {
    const q = tripleInt('urn:s', 'urn:p', 5, 'urn:g');
    expect(typeof q.subject).toBe('string');
    expect(typeof q.predicate).toBe('string');
    expect(typeof q.object).toBe('string');
    expect(typeof q.graph).toBe('string');
  });
});

// =========================================================================
// transformUser
// =========================================================================

describe('transformUser', () => {
  it('produces User type triple with login', () => {
    const quads = transformUser(sampleUser, GRAPH);
    const typeQuad = findQuad(quads, `${RDF}type`);
    expect(typeQuad?.object).toBe(`${GH}User`);
    const loginQuad = findQuad(quads, `${GH}login`);
    expect(loginQuad?.object).toBe('"octocat"');
  });

  it('includes avatarUrl and htmlUrl', () => {
    const quads = transformUser(sampleUser, GRAPH);
    expect(findQuad(quads, `${GH}avatarUrl`)).toBeDefined();
    expect(findQuad(quads, `${GH}htmlUrl`)).toBeDefined();
  });

  it('returns empty array for null/undefined login', () => {
    expect(transformUser(null, GRAPH)).toEqual([]);
    expect(transformUser({}, GRAPH)).toEqual([]);
    expect(transformUser({ login: '' }, GRAPH)).toEqual([]);
  });

  it('adds Organization type for org users', () => {
    const quads = transformUser({ login: 'org1', type: 'Organization' }, GRAPH);
    const types = findQuads(quads, `${RDF}type`);
    const typeValues = types.map(q => q.object);
    expect(typeValues).toContain(`${GH}User`);
    expect(typeValues).toContain(`${GH}Organization`);
  });

  it('sets all quads to the given graph', () => {
    const quads = transformUser(sampleUser, GRAPH);
    assertGraph(quads, GRAPH);
  });
});

// =========================================================================
// transformRepository
// =========================================================================

describe('transformRepository', () => {
  it('produces Repository type and fullName', () => {
    const quads = transformRepository(sampleRepository, GRAPH);
    const typeQuad = findQuad(quads, `${RDF}type`);
    expect(typeQuad?.object).toBe(`${GH}Repository`);
    expect(typeQuad?.subject).toBe('urn:github:octocat/Hello-World');
    const fullName = findQuad(quads, `${GH}fullName`);
    expect(fullName?.object).toBe('"octocat/Hello-World"');
  });

  it('includes description', () => {
    const quads = transformRepository(sampleRepository, GRAPH);
    const desc = findQuad(quads, `${GH}description`);
    expect(desc?.object).toBe('"This your first repo!"');
  });

  it('includes htmlUrl, defaultBranch', () => {
    const quads = transformRepository(sampleRepository, GRAPH);
    expect(findQuad(quads, `${GH}htmlUrl`)).toBeDefined();
    expect(findQuad(quads, `${GH}defaultBranch`)?.object).toBe('"main"');
  });

  it('includes owner link and user quads', () => {
    const quads = transformRepository(sampleRepository, GRAPH);
    const ownerLink = findQuad(quads, `${GH}owner`);
    expect(ownerLink?.object).toBe('urn:github:user/octocat');
    // Owner user quads are embedded
    const ownerType = findQuad(quads, `${RDF}type`, 'urn:github:user/octocat');
    expect(ownerType?.object).toBe(`${GH}User`);
  });

  it('handles numeric fields (starCount, forkCount, openIssueCount)', () => {
    const repoWithCounts = {
      ...sampleRepository,
      stargazers_count: 500,
      forks_count: 100,
      open_issues_count: 20,
    };
    const quads = transformRepository(repoWithCounts, GRAPH);
    expect(findQuad(quads, `${GH}starCount`)?.object).toBe(`"500"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}forkCount`)?.object).toBe(`"100"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}openIssueCount`)?.object).toBe(`"20"^^<${XSD}integer>`);
  });

  it('handles boolean archived field', () => {
    const repoArchived = { ...sampleRepository, archived: true };
    const quads = transformRepository(repoArchived, GRAPH);
    expect(findQuad(quads, `${GH}archived`)?.object).toBe(`"true"^^<${XSD}boolean>`);
  });

  it('handles topics array', () => {
    const repoWithTopics = { ...sampleRepository, topics: ['dkg', 'web3', 'rdf'] };
    const quads = transformRepository(repoWithTopics, GRAPH);
    const topicQuads = findQuads(quads, `${GH}topics`);
    expect(topicQuads).toHaveLength(3);
    const topicValues = topicQuads.map(q => q.object);
    expect(topicValues).toContain('"dkg"');
    expect(topicValues).toContain('"web3"');
    expect(topicValues).toContain('"rdf"');
  });

  it('includes snapshotAt dateTime', () => {
    const quads = transformRepository(sampleRepository, GRAPH);
    const snapshot = findQuad(quads, `${GH}snapshotAt`);
    expect(snapshot?.object).toMatch(/^\"\d{4}-\d{2}-\d{2}T.*\"\^\^<.*dateTime>$/);
  });

  it('includes createdAt and updatedAt', () => {
    const quads = transformRepository(sampleRepository, GRAPH);
    expect(findQuad(quads, `${GH}createdAt`)).toBeDefined();
    expect(findQuad(quads, `${GH}updatedAt`)).toBeDefined();
  });

  it('includes forkedFrom link when parent exists', () => {
    const forked = { ...sampleRepository, parent: { owner: { login: 'upstream' }, name: 'orig-repo' } };
    const quads = transformRepository(forked, GRAPH);
    const forkLink = findQuad(quads, `${GH}forkedFrom`);
    expect(forkLink?.object).toBe('urn:github:upstream/orig-repo');
  });

  it('returns empty array when owner or name is missing', () => {
    expect(transformRepository({}, GRAPH)).toEqual([]);
    expect(transformRepository({ name: 'test' }, GRAPH)).toEqual([]);
    expect(transformRepository({ owner: { login: 'x' } }, GRAPH)).toEqual([]);
  });

  it('handles optional fields being null/undefined gracefully', () => {
    const minimal = { name: 'test', owner: { login: 'x' } };
    const quads = transformRepository(minimal, GRAPH);
    // Should have at least type, fullName, snapshotAt, and owner quads
    expect(quads.length).toBeGreaterThanOrEqual(4);
    // No description quad since it's missing
    expect(findQuad(quads, `${GH}description`)).toBeUndefined();
  });

  it('sets all quads to the given graph', () => {
    const quads = transformRepository(sampleRepository, GRAPH);
    assertGraph(quads, GRAPH);
  });
});

// =========================================================================
// transformPullRequest
// =========================================================================

describe('transformPullRequest', () => {
  const OWNER = 'octocat';
  const REPO = 'Hello-World';

  it('produces PullRequest and PROV Activity types', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    const types = findQuads(quads, `${RDF}type`, prUri(OWNER, REPO, 42));
    const typeValues = types.map(q => q.object);
    expect(typeValues).toContain(`${GH}PullRequest`);
    expect(typeValues).toContain(`${PROV}Activity`);
  });

  it('includes prNumber, title, body, state', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}prNumber`)?.object).toBe(`"42"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}title`)?.object).toBe('"Add feature X"');
    expect(findQuad(quads, `${GH}body`)?.object).toContain('feature X');
    expect(findQuad(quads, `${GH}state`)?.object).toBe('"open"');
  });

  it('sets state to merged when merged_at is present', () => {
    const mergedPR = { ...samplePullRequest, state: 'closed', merged_at: '2024-01-17T00:00:00Z' };
    const quads = transformPullRequest(mergedPR, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}state`)?.object).toBe('"merged"');
    expect(findQuad(quads, `${GH}mergedAt`)).toBeDefined();
  });

  it('includes baseBranch and headBranch', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}baseBranch`)?.object).toBe('"main"');
    expect(findQuad(quads, `${GH}headBranch`)?.object).toBe('"feature-x"');
  });

  it('includes headSha', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}headSha`)?.object).toContain('abc1234');
  });

  it('includes inRepo link', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    const inRepo = findQuad(quads, `${GH}inRepo`);
    expect(inRepo?.object).toBe(repoUri(OWNER, REPO));
  });

  it('includes author link and user quads', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    const authorLink = findQuad(quads, `${GH}author`, prUri(OWNER, REPO, 42));
    expect(authorLink?.object).toBe(userUri('octocat'));
  });

  it('includes draft boolean', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}draft`)?.object).toBe(`"false"^^<${XSD}boolean>`);
  });

  it('includes additions, deletions, changedFileCount', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}totalAdditions`)?.object).toBe(`"150"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}totalDeletions`)?.object).toBe(`"30"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}changedFileCount`)?.object).toBe(`"5"^^<${XSD}integer>`);
  });

  it('includes labels with label entity quads', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    const labelLink = findQuad(quads, `${GH}hasLabel`);
    expect(labelLink?.object).toBe(labelUri(OWNER, REPO, 'enhancement'));
    // Label entity quads should be present
    const labelType = findQuad(quads, `${RDF}type`, labelUri(OWNER, REPO, 'enhancement'));
    expect(labelType?.object).toBe(`${GH}Label`);
  });

  it('includes mergeCommit link when present', () => {
    const prWithMerge = { ...samplePullRequest, merge_commit_sha: 'merge123abc' };
    const quads = transformPullRequest(prWithMerge, OWNER, REPO, GRAPH);
    const mergeLink = findQuad(quads, `${GH}mergeCommit`);
    expect(mergeLink?.object).toBe(commitUri(OWNER, REPO, 'merge123abc'));
  });

  it('includes requested reviewers', () => {
    const prWithReviewers = {
      ...samplePullRequest,
      requested_reviewers: [{ login: 'reviewer-1', type: 'User' }],
    };
    const quads = transformPullRequest(prWithReviewers, OWNER, REPO, GRAPH);
    const reviewRequestLink = findQuad(quads, `${GH}reviewRequestedFrom`);
    expect(reviewRequestLink?.object).toBe(userUri('reviewer-1'));
  });

  it('includes mergedBy link when present', () => {
    const prMerged = {
      ...samplePullRequest,
      merged_by: { login: 'merger', type: 'User' },
    };
    const quads = transformPullRequest(prMerged, OWNER, REPO, GRAPH);
    const mergedByLink = findQuad(quads, `${GH}mergedBy`);
    expect(mergedByLink?.object).toBe(userUri('merger'));
  });

  it('returns empty array when number is missing', () => {
    expect(transformPullRequest({}, OWNER, REPO, GRAPH)).toEqual([]);
    expect(transformPullRequest({ number: 'not-a-number' }, OWNER, REPO, GRAPH)).toEqual([]);
  });

  it('includes timestamps (createdAt, updatedAt)', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}createdAt`)).toBeDefined();
    expect(findQuad(quads, `${GH}updatedAt`)).toBeDefined();
  });

  it('sets all quads to the given graph', () => {
    const quads = transformPullRequest(samplePullRequest, OWNER, REPO, GRAPH);
    assertGraph(quads, GRAPH);
  });
});

// =========================================================================
// transformPullRequestFiles
// =========================================================================

describe('transformPullRequestFiles', () => {
  const OWNER = 'octocat';
  const REPO = 'Hello-World';

  it('transforms file diffs with status, additions, deletions', () => {
    const files = [
      { filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 3, patch: '@@ -1,3 +1,10 @@' },
      { filename: 'src/new.ts', status: 'added', additions: 50, deletions: 0 },
    ];
    const quads = transformPullRequestFiles(files, OWNER, REPO, 42, GRAPH);

    const fileTypes = findQuads(quads, `${RDF}type`).filter(q => q.object === `${GH}FileDiff`);
    expect(fileTypes).toHaveLength(2);

    const file1Uri = fileDiffUri(OWNER, REPO, 42, 'src/index.ts');
    expect(findQuad(quads, `${GH}diffPath`, file1Uri)?.object).toBe('"src/index.ts"');
    expect(findQuad(quads, `${GH}diffStatus`, file1Uri)?.object).toBe('"modified"');
    expect(findQuad(quads, `${GH}additions`, file1Uri)?.object).toBe(`"10"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}patch`, file1Uri)?.object).toContain('@@ -1,3 +1,10 @@');
  });

  it('includes prFileDiff link from PR to each file', () => {
    const files = [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0 }];
    const quads = transformPullRequestFiles(files, OWNER, REPO, 42, GRAPH);
    const link = findQuad(quads, `${GH}prFileDiff`, prUri(OWNER, REPO, 42));
    expect(link?.object).toBe(fileDiffUri(OWNER, REPO, 42, 'README.md'));
  });

  it('includes previousPath for renamed files', () => {
    const files = [{ filename: 'new-name.ts', status: 'renamed', previous_filename: 'old-name.ts', additions: 0, deletions: 0 }];
    const quads = transformPullRequestFiles(files, OWNER, REPO, 42, GRAPH);
    expect(findQuad(quads, `${GH}previousPath`)?.object).toBe('"old-name.ts"');
  });

  it('skips files without filename', () => {
    const files = [{ status: 'modified' }, { filename: 'ok.ts', status: 'added', additions: 1, deletions: 0 }];
    const quads = transformPullRequestFiles(files, OWNER, REPO, 42, GRAPH);
    const fileTypes = findQuads(quads, `${RDF}type`).filter(q => q.object === `${GH}FileDiff`);
    expect(fileTypes).toHaveLength(1);
  });
});

// =========================================================================
// transformReview
// =========================================================================

describe('transformReview', () => {
  const OWNER = 'octocat';
  const REPO = 'Hello-World';

  it('produces Review and PROV Activity types', () => {
    const quads = transformReview(sampleReview, OWNER, REPO, 42, GRAPH);
    const uri = reviewUri(OWNER, REPO, 42, sampleReview.id);
    const types = findQuads(quads, `${RDF}type`, uri);
    const typeValues = types.map(q => q.object);
    expect(typeValues).toContain(`${GH}Review`);
    expect(typeValues).toContain(`${PROV}Activity`);
  });

  it('includes reviewState, body, submittedAt', () => {
    const quads = transformReview(sampleReview, OWNER, REPO, 42, GRAPH);
    expect(findQuad(quads, `${GH}reviewState`)?.object).toBe('"APPROVED"');
    expect(findQuad(quads, `${GH}body`)?.object).toContain('minor suggestions');
    expect(findQuad(quads, `${GH}submittedAt`)).toBeDefined();
  });

  it('includes reviewOf link to the PR', () => {
    const quads = transformReview(sampleReview, OWNER, REPO, 42, GRAPH);
    const reviewOfLink = findQuad(quads, `${GH}reviewOf`);
    expect(reviewOfLink?.object).toBe(prUri(OWNER, REPO, 42));
  });

  it('includes author link and user quads', () => {
    const quads = transformReview(sampleReview, OWNER, REPO, 42, GRAPH);
    const uri = reviewUri(OWNER, REPO, 42, sampleReview.id);
    const authorLink = findQuad(quads, `${GH}author`, uri);
    expect(authorLink?.object).toBe(userUri('reviewer-1'));
  });

  it('includes commitReviewed link', () => {
    const quads = transformReview(sampleReview, OWNER, REPO, 42, GRAPH);
    const commitLink = findQuad(quads, `${GH}commitReviewed`);
    expect(commitLink?.object).toBe(commitUri(OWNER, REPO, sampleReview.commit_id));
  });

  it('returns empty array when id is missing', () => {
    expect(transformReview({}, OWNER, REPO, 42, GRAPH)).toEqual([]);
    expect(transformReview(null, OWNER, REPO, 42, GRAPH)).toEqual([]);
  });

  it('sets all quads to the given graph', () => {
    const quads = transformReview(sampleReview, OWNER, REPO, 42, GRAPH);
    assertGraph(quads, GRAPH);
  });
});

// =========================================================================
// transformIssue
// =========================================================================

describe('transformIssue', () => {
  const OWNER = 'octocat';
  const REPO = 'Hello-World';

  it('produces Issue type with issueNumber and inRepo', () => {
    const quads = transformIssue(sampleIssue, OWNER, REPO, GRAPH);
    const uri = issueUri(OWNER, REPO, 10);
    const typeQuad = findQuad(quads, `${RDF}type`, uri);
    expect(typeQuad?.object).toBe(`${GH}Issue`);
    expect(findQuad(quads, `${GH}issueNumber`)?.object).toBe(`"10"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}inRepo`)?.object).toBe(repoUri(OWNER, REPO));
  });

  it('includes title, body, state', () => {
    const quads = transformIssue(sampleIssue, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}title`)?.object).toBe('"Bug: crash on startup"');
    expect(findQuad(quads, `${GH}body`)?.object).toContain('crashes');
    expect(findQuad(quads, `${GH}state`)?.object).toBe('"open"');
  });

  it('includes labels with label entity quads', () => {
    const quads = transformIssue(sampleIssue, OWNER, REPO, GRAPH);
    const labelLink = findQuad(quads, `${GH}hasLabel`);
    expect(labelLink?.object).toBe(labelUri(OWNER, REPO, 'bug'));
    // Label entity
    const labelName = findQuad(quads, `${GH}labelName`);
    expect(labelName?.object).toBe('"bug"');
  });

  it('includes assignees as user links', () => {
    const quads = transformIssue(sampleIssue, OWNER, REPO, GRAPH);
    const assignedLink = findQuad(quads, `${GH}assignedTo`);
    expect(assignedLink?.object).toBe(userUri('octocat'));
  });

  it('includes author link', () => {
    const quads = transformIssue(sampleIssue, OWNER, REPO, GRAPH);
    const uri = issueUri(OWNER, REPO, 10);
    const authorLink = findQuad(quads, `${GH}author`, uri);
    expect(authorLink?.object).toBe(userUri('octocat'));
  });

  it('skips pull requests disguised as issues', () => {
    const prAsIssue = { ...sampleIssue, pull_request: { url: 'https://...' } };
    expect(transformIssue(prAsIssue, OWNER, REPO, GRAPH)).toEqual([]);
  });

  it('returns empty array when number is missing', () => {
    expect(transformIssue({}, OWNER, REPO, GRAPH)).toEqual([]);
  });

  it('includes closedAt when present', () => {
    const closedIssue = { ...sampleIssue, state: 'closed', closed_at: '2024-01-20T00:00:00Z' };
    const quads = transformIssue(closedIssue, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}closedAt`)).toBeDefined();
  });

  it('sets all quads to the given graph', () => {
    const quads = transformIssue(sampleIssue, OWNER, REPO, GRAPH);
    assertGraph(quads, GRAPH);
  });
});

// =========================================================================
// transformCommit
// =========================================================================

describe('transformCommit', () => {
  const OWNER = 'octocat';
  const REPO = 'Hello-World';

  it('produces Commit and PROV Activity types', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    const uri = commitUri(OWNER, REPO, sampleCommit.sha);
    const types = findQuads(quads, `${RDF}type`, uri);
    const typeValues = types.map(q => q.object);
    expect(typeValues).toContain(`${GH}Commit`);
    expect(typeValues).toContain(`${PROV}Activity`);
  });

  it('includes sha, shortSha, and inRepo', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}sha`)?.object).toBe(`"${sampleCommit.sha}"`);
    expect(findQuad(quads, `${GH}shortSha`)?.object).toBe(`"${sampleCommit.sha.slice(0, 7)}"`);
    expect(findQuad(quads, `${GH}inRepo`)?.object).toBe(repoUri(OWNER, REPO));
  });

  it('includes commit message', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}message`)?.object).toContain('feature X');
  });

  it('includes committedAt and authoredAt from nested commit data', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}committedAt`)).toBeDefined();
    expect(findQuad(quads, `${GH}authoredAt`)).toBeDefined();
  });

  it('includes author user link from top-level author', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    const uri = commitUri(OWNER, REPO, sampleCommit.sha);
    const authorLink = findQuad(quads, `${GH}author`, uri);
    expect(authorLink?.object).toBe(userUri('octocat'));
  });

  it('includes parentCommit links', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    const parentLink = findQuad(quads, `${GH}parentCommit`);
    expect(parentLink?.object).toBe(commitUri(OWNER, REPO, 'parent123'));
  });

  it('sets isMergeCommit for commits with multiple parents', () => {
    const mergeCommit = {
      ...sampleCommit,
      parents: [
        { sha: 'parent1', url: '', html_url: '' },
        { sha: 'parent2', url: '', html_url: '' },
      ],
    };
    const quads = transformCommit(mergeCommit, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}isMergeCommit`)?.object).toBe(`"true"^^<${XSD}boolean>`);
  });

  it('does not set isMergeCommit for single parent', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}isMergeCommit`)).toBeUndefined();
  });

  it('includes stats when present', () => {
    const commitWithStats = { ...sampleCommit, stats: { additions: 50, deletions: 10 } };
    const quads = transformCommit(commitWithStats, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}totalAdditions`)?.object).toBe(`"50"^^<${XSD}integer>`);
    expect(findQuad(quads, `${GH}totalDeletions`)?.object).toBe(`"10"^^<${XSD}integer>`);
  });

  it('returns empty array when sha is missing', () => {
    expect(transformCommit({}, OWNER, REPO, GRAPH)).toEqual([]);
    expect(transformCommit({ sha: '' }, OWNER, REPO, GRAPH)).toEqual([]);
  });

  it('sets all quads to the given graph', () => {
    const quads = transformCommit(sampleCommit, OWNER, REPO, GRAPH);
    assertGraph(quads, GRAPH);
  });
});

// =========================================================================
// Edge cases
// =========================================================================

describe('edge cases', () => {
  const OWNER = 'octocat';
  const REPO = 'Hello-World';

  it('special characters in strings are properly escaped', () => {
    const issueWithSpecial = {
      ...sampleIssue,
      title: 'Fix "broken" feature\nnewline',
      body: 'Tab\there and backslash\\end',
    };
    const quads = transformIssue(issueWithSpecial, OWNER, REPO, GRAPH);
    const title = findQuad(quads, `${GH}title`);
    expect(title?.object).toBe('"Fix \\"broken\\" feature\\nnewline"');
    const body = findQuad(quads, `${GH}body`);
    expect(body?.object).toBe('"Tab\\there and backslash\\\\end"');
  });

  it('empty labels array produces no label quads', () => {
    const prNoLabels = { ...samplePullRequest, labels: [] };
    const quads = transformPullRequest(prNoLabels, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}hasLabel`)).toBeUndefined();
  });

  it('empty assignees array produces no assignee quads', () => {
    const issueNoAssignees = { ...sampleIssue, assignees: [] };
    const quads = transformIssue(issueNoAssignees, OWNER, REPO, GRAPH);
    expect(findQuad(quads, `${GH}assignedTo`)).toBeUndefined();
  });

  it('null body does not produce body quad', () => {
    const prNoBody = { ...samplePullRequest, body: null };
    const quads = transformPullRequest(prNoBody, OWNER, REPO, GRAPH);
    const prU = prUri(OWNER, REPO, 42);
    expect(findQuad(quads, `${GH}body`, prU)).toBeUndefined();
  });

  it('label with special characters in name is URI-encoded', () => {
    const prWithSpecialLabel = {
      ...samplePullRequest,
      labels: [{ id: 99, name: 'bug fix/urgent', color: 'ff0000' }],
    };
    const quads = transformPullRequest(prWithSpecialLabel, OWNER, REPO, GRAPH);
    const labelLink = findQuad(quads, `${GH}hasLabel`);
    expect(labelLink?.object).toBe(labelUri(OWNER, REPO, 'bug fix/urgent'));
    expect(labelLink?.object).toContain('bug%20fix');
  });

  it('review without body does not produce body quad', () => {
    const reviewNoBody = { ...sampleReview, body: '' };
    const quads = transformReview(reviewNoBody, OWNER, REPO, 42, GRAPH);
    expect(findQuad(quads, `${GH}body`)).toBeUndefined();
  });

  it('commit with empty string sha returns empty array', () => {
    expect(transformCommit({ sha: '' }, OWNER, REPO, GRAPH)).toEqual([]);
  });
});

// =========================================================================
// bv() — N-Triples binding value parser (from ui/src/api.ts)
// =========================================================================

// bv() is a pure function, safe to import in Node.js
import { bv } from '../ui/src/api.js';

describe('bv() — N-Triples binding value parser', () => {
  it('returns empty string for null/undefined', () => {
    expect(bv(null)).toBe('');
    expect(bv(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(bv('')).toBe('');
  });

  it('strips typed literal suffix', () => {
    expect(bv('"42"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe('42');
    expect(bv('"true"^^<http://www.w3.org/2001/XMLSchema#boolean>')).toBe('true');
    expect(bv('"2024-01-15"^^<http://www.w3.org/2001/XMLSchema#date>')).toBe('2024-01-15');
  });

  it('strips language tag', () => {
    expect(bv('"hello"@en')).toBe('hello');
    expect(bv('"bonjour"@fr')).toBe('bonjour');
  });

  it('strips plain quotes', () => {
    expect(bv('"plain value"')).toBe('plain value');
  });

  it('passes through bare URIs unchanged', () => {
    expect(bv('urn:github:octocat/Hello-World')).toBe('urn:github:octocat/Hello-World');
    expect(bv('http://example.com')).toBe('http://example.com');
  });

  it('passes through already-clean strings', () => {
    expect(bv('just a string')).toBe('just a string');
  });

  it('unescapes escaped quotes in typed literals', () => {
    expect(bv('"value with \\"quotes\\""^^<http://www.w3.org/2001/XMLSchema#string>')).toBe('value with "quotes"');
  });

  it('unescapes newlines in typed literals', () => {
    expect(bv('"line1\\nline2"^^<http://www.w3.org/2001/XMLSchema#string>')).toBe('line1\nline2');
  });

  it('unescapes backslashes in typed literals', () => {
    expect(bv('"path\\\\to\\\\file"^^<http://www.w3.org/2001/XMLSchema#string>')).toBe('path\\to\\file');
  });

  it('handles typed literal without type (just quoted)', () => {
    // The regex makes ^^<type> optional, so plain "value" also matches
    expect(bv('"hello world"')).toBe('hello world');
  });
});
