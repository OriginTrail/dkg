/**
 * E2E validation: full pipeline against https://github.com/OriginTrail/dkg-v9
 *
 * Requires: GITHUB_TOKEN env var (optional for public repos but avoids rate limits)
 * Run with: pnpm test:e2e
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GitHubClient } from '../../src/github/client.js';
import {
  transformRepository,
  transformPullRequest,
  transformPullRequestFiles,
  transformReview,
  transformIssue,
  transformCommit,
  transformUser,
} from '../../src/rdf/transformer.js';
import { repoUri, prUri, issueUri, commitUri, userUri, paranetId, GH, RDF, PROV } from '../../src/rdf/uri.js';
import type { Quad } from '../../src/rdf/uri.js';

const OWNER = 'OriginTrail';
const REPO = 'dkg-v9';
const GRAPH = `did:dkg:paranet:${paranetId(OWNER, REPO)}/_workspace`;

const token = process.env.GITHUB_TOKEN ?? undefined;

describe('Real-world validation: OriginTrail/dkg-v9', () => {
  let client: GitHubClient;
  const allQuads: Quad[] = [];
  const quadsByType = new Map<string, number>();

  function countType(quads: Quad[], typeName: string): void {
    const count = quads.filter(q => q.predicate === `${RDF}type` && q.object === `${GH}${typeName}`).length;
    quadsByType.set(typeName, (quadsByType.get(typeName) ?? 0) + count);
  }

  function collectQuads(quads: Quad[]): void {
    allQuads.push(...quads);
  }

  beforeAll(() => {
    client = new GitHubClient({ token });
  });

  // --- 1. Repository metadata ---

  it('fetches and transforms repository metadata', async () => {
    const repoData = await client.getRepository(OWNER, REPO);
    expect(repoData).toBeDefined();
    expect(repoData.full_name).toBe(`${OWNER}/${REPO}`);

    const quads = transformRepository(repoData, GRAPH);
    expect(quads.length).toBeGreaterThan(5);

    // Must have rdf:type Repository
    const typeQuad = quads.find(q => q.predicate === `${RDF}type` && q.object === `${GH}Repository`);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.subject).toBe(repoUri(OWNER, REPO));

    // Must have fullName
    const nameQuad = quads.find(q => q.predicate === `${GH}fullName`);
    expect(nameQuad).toBeDefined();
    expect(nameQuad!.object).toContain(`${OWNER}/${REPO}`);

    // Must have githubId
    const idQuad = quads.find(q => q.predicate === `${GH}githubId`);
    expect(idQuad).toBeDefined();

    // Must have owner user
    const ownerQuad = quads.find(q => q.predicate === `${GH}owner`);
    expect(ownerQuad).toBeDefined();

    // Must have description (not body)
    if (repoData.description) {
      const descQuad = quads.find(q => q.predicate === `${GH}description`);
      expect(descQuad).toBeDefined();
      const bodyQuad = quads.find(q => q.predicate === `${GH}body`);
      expect(bodyQuad).toBeUndefined();
    }

    countType(quads, 'Repository');
    countType(quads, 'User');
    collectQuads(quads);
  });

  // --- 2. Pull requests ---

  let prNumbers: number[] = [];

  it('fetches and transforms 5 recent PRs', async () => {
    const prs = await client.listPullRequests(OWNER, REPO, { state: 'all', perPage: 5 });
    expect(prs.length).toBeGreaterThanOrEqual(1);
    prNumbers = prs.map((pr: any) => pr.number);

    for (const pr of prs) {
      const quads = transformPullRequest(pr, OWNER, REPO, GRAPH);
      expect(quads.length).toBeGreaterThan(5);

      // Must have rdf:type PullRequest and prov:Activity
      expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${GH}PullRequest`)).toBe(true);
      expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${PROV}Activity`)).toBe(true);

      // Must have prNumber
      expect(quads.some(q => q.predicate === `${GH}prNumber`)).toBe(true);

      // Must have githubId and nodeId
      expect(quads.some(q => q.predicate === `${GH}githubId`)).toBe(true);

      // Must have inRepo
      expect(quads.some(q => q.predicate === `${GH}inRepo` && q.object === repoUri(OWNER, REPO))).toBe(true);

      // Author must have prov:wasAssociatedWith
      if (pr.user?.login) {
        expect(quads.some(q => q.predicate === `${PROV}wasAssociatedWith`)).toBe(true);
      }

      // URI must match pattern
      expect(quads[0].subject).toBe(prUri(OWNER, REPO, pr.number));

      // All quads must have correct graph
      for (const q of quads) {
        expect(q.graph).toBe(GRAPH);
      }

      countType(quads, 'PullRequest');
      countType(quads, 'User');
      collectQuads(quads);
    }
  });

  // --- 3. PR files ---

  it('fetches and transforms PR files for recent PRs', async () => {
    expect(prNumbers.length).toBeGreaterThanOrEqual(1);

    for (const prNum of prNumbers.slice(0, 3)) {
      const files = await client.getPullRequestFiles(OWNER, REPO, prNum);
      if (files.length === 0) continue;

      const quads = transformPullRequestFiles(files, OWNER, REPO, prNum, GRAPH);
      expect(quads.length).toBeGreaterThan(0);

      // Must have FileDiff type triples
      expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${GH}FileDiff`)).toBe(true);

      // Must have diffPath
      expect(quads.some(q => q.predicate === `${GH}diffPath`)).toBe(true);

      // Must link to PR via prFileDiff
      expect(quads.some(q => q.predicate === `${GH}prFileDiff`)).toBe(true);

      countType(quads, 'FileDiff');
      collectQuads(quads);
    }
  });

  // --- 4. Reviews ---

  it('fetches and transforms reviews for recent PRs', async () => {
    expect(prNumbers.length).toBeGreaterThanOrEqual(1);
    let totalReviewQuads = 0;

    for (const prNum of prNumbers.slice(0, 3)) {
      const reviews = await client.getPullRequestReviews(OWNER, REPO, prNum);
      for (const review of reviews) {
        const quads = transformReview(review, OWNER, REPO, prNum, GRAPH);
        if (quads.length === 0) continue;

        // Must have rdf:type Review and prov:Activity
        expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${GH}Review`)).toBe(true);
        expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${PROV}Activity`)).toBe(true);

        // Must have reviewOf linking to PR
        expect(quads.some(q => q.predicate === `${GH}reviewOf` && q.object === prUri(OWNER, REPO, prNum))).toBe(true);

        // Must have reviewState
        expect(quads.some(q => q.predicate === `${GH}reviewState`)).toBe(true);

        // Must have githubId
        expect(quads.some(q => q.predicate === `${GH}githubId`)).toBe(true);

        // Author must have prov:wasAssociatedWith
        if (review.user?.login) {
          expect(quads.some(q => q.predicate === `${PROV}wasAssociatedWith`)).toBe(true);
        }

        totalReviewQuads += quads.length;
        countType(quads, 'Review');
        collectQuads(quads);
      }
    }

    // At least some PRs should have reviews in a mature repo
    expect(totalReviewQuads).toBeGreaterThan(0);
  });

  // --- 5. Issues ---

  it('fetches and transforms 5 recent issues', async () => {
    const issues = await client.listIssues(OWNER, REPO, { state: 'all', perPage: 10 });
    // Filter out PRs (GitHub /issues endpoint includes PRs)
    const realIssues = issues.filter((i: any) => !i.pull_request);

    for (const issue of realIssues.slice(0, 5)) {
      const quads = transformIssue(issue, OWNER, REPO, GRAPH);
      if (quads.length === 0) continue; // skip if filtered as PR

      // Must have rdf:type Issue
      expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${GH}Issue`)).toBe(true);

      // Must have issueNumber
      expect(quads.some(q => q.predicate === `${GH}issueNumber`)).toBe(true);

      // Must have githubId
      expect(quads.some(q => q.predicate === `${GH}githubId`)).toBe(true);

      // Must have inRepo
      expect(quads.some(q => q.predicate === `${GH}inRepo`)).toBe(true);

      countType(quads, 'Issue');
      collectQuads(quads);
    }
  });

  // --- 6. Commits ---

  it('fetches and transforms 10 recent commits', async () => {
    const commits = await client.listCommits(OWNER, REPO, { perPage: 10 });
    expect(commits.length).toBeGreaterThanOrEqual(1);

    for (const commit of commits) {
      const quads = transformCommit(commit, OWNER, REPO, GRAPH);
      expect(quads.length).toBeGreaterThan(3);

      // Must have rdf:type Commit and prov:Activity
      expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${GH}Commit`)).toBe(true);
      expect(quads.some(q => q.predicate === `${RDF}type` && q.object === `${PROV}Activity`)).toBe(true);

      // Must have sha
      expect(quads.some(q => q.predicate === `${GH}sha`)).toBe(true);

      // Must have shortSha
      expect(quads.some(q => q.predicate === `${GH}shortSha`)).toBe(true);

      // URI must match pattern
      expect(quads[0].subject).toBe(commitUri(OWNER, REPO, commit.sha));

      // Author prov:wasAssociatedWith (if GitHub user linked)
      if (commit.author?.login) {
        expect(quads.some(q => q.predicate === `${PROV}wasAssociatedWith`)).toBe(true);
      }

      countType(quads, 'Commit');
      collectQuads(quads);
    }
  });

  // --- 7. Summary and assertions ---

  it('validates aggregate quad counts and entity coverage', () => {
    // Total quads
    expect(allQuads.length).toBeGreaterThan(100);

    // All quads must have valid shape
    for (const q of allQuads) {
      expect(q.subject).toBeTruthy();
      expect(q.predicate).toBeTruthy();
      expect(q.object).toBeTruthy();
      expect(q.graph).toBe(GRAPH);
    }

    // Must have all core entity types present
    const requiredTypes = ['Repository', 'PullRequest', 'User', 'Commit'];
    for (const type of requiredTypes) {
      const count = quadsByType.get(type) ?? 0;
      expect(count, `Expected at least 1 ${type} entity`).toBeGreaterThan(0);
    }

    // Report
    console.log('\n--- Validation Summary ---');
    console.log(`Total quads: ${allQuads.length}`);
    console.log('Entity counts:');
    for (const [type, count] of quadsByType.entries()) {
      console.log(`  ${type}: ${count}`);
    }

    // Unique subjects (entities)
    const uniqueSubjects = new Set(allQuads.map(q => q.subject));
    console.log(`Unique entities: ${uniqueSubjects.size}`);

    // Unique predicates
    const uniquePredicates = new Set(allQuads.map(q => q.predicate));
    console.log(`Unique predicates: ${uniquePredicates.size}`);
    console.log('--- End Summary ---\n');
  });

  // --- 8. Quad shape validation ---

  it('validates all quads have well-formed URIs and literals', () => {
    for (const q of allQuads) {
      // Subject must be a URN or URI
      expect(
        q.subject.startsWith('urn:') || q.subject.startsWith('http'),
        `Invalid subject: ${q.subject}`,
      ).toBe(true);

      // Predicate must be a full URI
      expect(
        q.predicate.startsWith('http'),
        `Invalid predicate: ${q.predicate}`,
      ).toBe(true);

      // Object is either a URI or a literal
      const isUri = q.object.startsWith('urn:') || q.object.startsWith('http');
      const isLiteral = q.object.startsWith('"');
      expect(
        isUri || isLiteral,
        `Invalid object (not URI or literal): ${q.object.slice(0, 80)}`,
      ).toBe(true);
    }
  });

  // --- 9. SPARQL-style query simulation ---

  it('can find PRs by filtering quads (simulated SPARQL)', () => {
    const prQuads = allQuads.filter(
      q => q.predicate === `${RDF}type` && q.object === `${GH}PullRequest`,
    );
    expect(prQuads.length).toBeGreaterThan(0);

    // Each PR must have a title
    for (const prQ of prQuads) {
      const titleQuad = allQuads.find(
        q => q.subject === prQ.subject && q.predicate === `${GH}title`,
      );
      expect(titleQuad, `PR ${prQ.subject} missing title`).toBeDefined();
    }
  });

  it('can find reviews linked to their PRs (simulated join)', () => {
    const reviewQuads = allQuads.filter(
      q => q.predicate === `${RDF}type` && q.object === `${GH}Review`,
    );

    for (const rQ of reviewQuads) {
      // Review must have reviewOf pointing to a known PR
      const reviewOfQuad = allQuads.find(
        q => q.subject === rQ.subject && q.predicate === `${GH}reviewOf`,
      );
      expect(reviewOfQuad, `Review ${rQ.subject} missing reviewOf`).toBeDefined();

      // The PR target must have rdf:type PullRequest
      if (reviewOfQuad) {
        const prTypeQuad = allQuads.find(
          q => q.subject === reviewOfQuad.object && q.predicate === `${RDF}type` && q.object === `${GH}PullRequest`,
        );
        expect(prTypeQuad, `Review ${rQ.subject} points to non-PR: ${reviewOfQuad.object}`).toBeDefined();
      }
    }
  });

  it('can find users with provenance links (simulated PROV-O query)', () => {
    const provQuads = allQuads.filter(q => q.predicate === `${PROV}wasAssociatedWith`);
    expect(provQuads.length).toBeGreaterThan(0);

    // Each prov:wasAssociatedWith target must be a User
    for (const pQ of provQuads) {
      const userTypeQuad = allQuads.find(
        q => q.subject === pQ.object && q.predicate === `${RDF}type` && q.object === `${GH}User`,
      );
      expect(userTypeQuad, `prov:wasAssociatedWith target ${pQ.object} is not a User`).toBeDefined();
    }
  });

  // --- 10. OxigraphStore + real SPARQL queries ---

  it('loads all quads into OxigraphStore and runs SPARQL queries', async () => {
    const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
    const store = new OxigraphStore();

    // Filter out quads with invalid IRI characters before inserting
    // (some real GitHub data may produce URIs with characters like [ ] that are invalid in N-Quads)
    const invalidIriChars = /[\[\]{}<>|\\^`\s]/;
    const validQuads = allQuads.filter(q => {
      const isLiteral = (s: string) => s.startsWith('"');
      const isBlankNode = (s: string) => s.startsWith('_:');
      const hasInvalidIri = (s: string) => !isLiteral(s) && !isBlankNode(s) && invalidIriChars.test(s);
      if (hasInvalidIri(q.subject) || hasInvalidIri(q.predicate) || hasInvalidIri(q.object) || hasInvalidIri(q.graph)) {
        console.warn(`Skipping quad with invalid IRI: ${q.subject} ${q.predicate} ${q.object.slice(0, 60)}`);
        return false;
      }
      return true;
    });
    const skipped = allQuads.length - validQuads.length;
    if (skipped > 0) console.log(`Filtered ${skipped} quads with invalid IRIs`);

    await store.insert(validQuads);
    const totalStored = await store.countQuads();
    expect(totalStored).toBeGreaterThan(100);
    console.log(`\n--- OxigraphStore loaded ${totalStored} quads ---`);

    // All our quads are in a named graph — must use GRAPH clause for Oxigraph direct queries
    // (DKGQueryEngine auto-wraps with GRAPH when paranetId is provided, but raw OxigraphStore doesn't)
    const G = GRAPH;

    // Query 1: List repositories
    const q1 = await store.query(`
      SELECT ?repo ?name WHERE {
        GRAPH <${G}> {
          ?repo <${RDF}type> <${GH}Repository> ;
                <${GH}fullName> ?name .
        }
      }
    `);
    expect(q1.type).toBe('bindings');
    if (q1.type === 'bindings') {
      expect(q1.bindings.length).toBeGreaterThanOrEqual(1);
      console.log(`Query 1 (Repositories): ${q1.bindings.length} results`);
    }

    // Query 2: Find PRs with titles
    const q2 = await store.query(`
      SELECT ?pr ?number ?title WHERE {
        GRAPH <${G}> {
          ?pr <${RDF}type> <${GH}PullRequest> ;
              <${GH}prNumber> ?number ;
              <${GH}title> ?title .
        }
      }
      ORDER BY DESC(?number)
      LIMIT 10
    `);
    expect(q2.type).toBe('bindings');
    if (q2.type === 'bindings') {
      expect(q2.bindings.length).toBeGreaterThanOrEqual(1);
      console.log(`Query 2 (PRs with titles): ${q2.bindings.length} results`);
    }

    // Query 7: Find issues
    const q7 = await store.query(`
      SELECT ?issue ?number ?title WHERE {
        GRAPH <${G}> {
          ?issue <${RDF}type> <${GH}Issue> ;
                 <${GH}issueNumber> ?number ;
                 <${GH}title> ?title .
        }
      }
      LIMIT 10
    `);
    expect(q7.type).toBe('bindings');
    if (q7.type === 'bindings') {
      console.log(`Query 7 (Issues): ${q7.bindings.length} results`);
    }

    // Query 8: Contributor activity (users with commits/PRs/reviews)
    const q8 = await store.query(`
      SELECT ?login (COUNT(DISTINCT ?commit) AS ?commits)
             (COUNT(DISTINCT ?pr) AS ?prs)
             (COUNT(DISTINCT ?review) AS ?reviews) WHERE {
        GRAPH <${G}> {
          ?user <${RDF}type> <${GH}User> ;
                <${GH}login> ?login .
          OPTIONAL { ?commit <${RDF}type> <${GH}Commit> ; <${GH}author> ?user }
          OPTIONAL { ?pr <${RDF}type> <${GH}PullRequest> ; <${GH}author> ?user }
          OPTIONAL { ?review <${RDF}type> <${GH}Review> ; <${GH}author> ?user }
        }
      }
      GROUP BY ?login
      LIMIT 20
    `);
    expect(q8.type).toBe('bindings');
    if (q8.type === 'bindings') {
      console.log(`Query 8 (Contributors): ${q8.bindings.length} results`);
    }

    // Query: Reviews linked to PRs (tests the join)
    const qReviews = await store.query(`
      SELECT ?review ?state ?prTitle WHERE {
        GRAPH <${G}> {
          ?review <${RDF}type> <${GH}Review> ;
                  <${GH}reviewState> ?state ;
                  <${GH}reviewOf> ?pr .
          ?pr <${GH}title> ?prTitle .
        }
      }
      LIMIT 10
    `);
    expect(qReviews.type).toBe('bindings');
    if (qReviews.type === 'bindings') {
      console.log(`Query (Reviews→PRs join): ${qReviews.bindings.length} results`);
      // Reviews should link to real PRs
      if (qReviews.bindings.length > 0) {
        expect(qReviews.bindings[0]['prTitle']).toBeTruthy();
      }
    }

    // Query: Commits with authors
    const qCommits = await store.query(`
      SELECT ?sha ?msg ?login WHERE {
        GRAPH <${G}> {
          ?c <${RDF}type> <${GH}Commit> ;
             <${GH}shortSha> ?sha ;
             <${GH}message> ?msg .
          OPTIONAL {
            ?c <${PROV}wasAssociatedWith> ?user .
            ?user <${GH}login> ?login .
          }
        }
      }
      LIMIT 10
    `);
    expect(qCommits.type).toBe('bindings');
    if (qCommits.type === 'bindings') {
      expect(qCommits.bindings.length).toBeGreaterThanOrEqual(1);
      console.log(`Query (Commits with authors): ${qCommits.bindings.length} results`);
    }

    // Query: File diffs linked to PRs
    const qFiles = await store.query(`
      SELECT ?pr ?path ?status WHERE {
        GRAPH <${G}> {
          ?pr <${GH}prFileDiff> ?diff .
          ?diff <${RDF}type> <${GH}FileDiff> ;
                <${GH}diffPath> ?path .
          OPTIONAL { ?diff <${GH}diffStatus> ?status }
        }
      }
      LIMIT 20
    `);
    expect(qFiles.type).toBe('bindings');
    if (qFiles.type === 'bindings') {
      console.log(`Query (FileDiffs): ${qFiles.bindings.length} results`);
    }

    console.log('--- All SPARQL queries passed ---\n');
  });
});
