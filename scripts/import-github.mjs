#!/usr/bin/env node
/**
 * Pull GitHub data for OriginTrail/dkg-v9 and write it into the `github`
 * sub-graph of the dkg-code-project, cross-linking PRs/commits to code:File
 * URIs that match the path scheme produced by import-code-graph.mjs.
 *
 * Data scraped via `gh api` (must be logged-in via `gh auth login`):
 *   - last ~40 PRs:      title, state, author, merged, body (truncated), counts, files
 *   - last ~30 issues:   title, state, author, body (truncated), closed-by-PR
 *   - last ~60 commits:  sha, author, message, files touched
 *   - reviews on PRs:    verdict, reviewer
 *
 * Usage:
 *   node scripts/import-github.mjs
 *   node scripts/import-github.mjs --repo=OriginTrail/dkg-v9 --prs=40 --issues=30 --commits=60
 *   node scripts/import-github.mjs --dry-run --out=/tmp/github.nt
 *
 * Cached responses live in `.cache/gh-import/` so repeated runs don't
 * re-hit the API while iterating on the importer.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import {
  Github,
  Code,
  Common,
  XSD,
  NS,
  createTripleSink,
  uri,
  lit,
} from './lib/ontology.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9201').replace(/\/$/, '');
const PROJECT_ID = args.project ?? 'dkg-code-project';
const SUBGRAPH = args.subgraph ?? 'github';
const ASSERTION_NAME = args.assertion ?? 'github-activity';
const REPO = args.repo ?? 'OriginTrail/dkg-v9';
const [OWNER, REPO_NAME] = REPO.split('/');
const N_PRS = args.prs ? Number(args.prs) : 40;
const N_ISSUES = args.issues ? Number(args.issues) : 30;
const N_COMMITS = args.commits ? Number(args.commits) : 60;
const DRY_RUN = args['dry-run'] === 'true';
const OUT_FILE = args.out ?? null;

const cacheDir = path.join(REPO_ROOT, '.cache', 'gh-import');
fs.mkdirSync(cacheDir, { recursive: true });

function gh(endpoint, { jq, noCache } = {}) {
  const key = (endpoint + (jq ? `::${jq}` : '')).replace(/[^\w.-]+/g, '_');
  const cacheFile = path.join(cacheDir, key + '.json');
  if (!noCache && fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  const args = ['api', endpoint];
  if (jq) args.push('--jq', jq);
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const parsed = raw.trim() ? JSON.parse(raw) : null;
  fs.writeFileSync(cacheFile, JSON.stringify(parsed));
  return parsed;
}

// Build a map of known internal file paths (repo-relative) so we can
// cross-link PR/commit-touched paths into code:File URIs.
function buildInternalFileIndex() {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  if (!fs.existsSync(packagesDir)) return new Map();
  const map = new Map();
  for (const ent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, ent.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch { continue; }
    const pkgName = pkgJson.name ?? ent.name;
    const rootDir = path.join(packagesDir, ent.name);
    walk(rootDir, (abs) => {
      const relToPkg = path.relative(rootDir, abs);
      const relToRepo = path.relative(REPO_ROOT, abs);
      if (relToPkg.startsWith('src/') && /\.(ts|tsx)$/.test(abs) && !/\.d\.ts$/.test(abs) && !/\.(test|spec)\.(ts|tsx)$/.test(abs)) {
        map.set(relToRepo, Code.uri.file(pkgName, relToPkg));
      }
    });
  }
  return map;
}

function walk(dir, onFile) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '__tests__' || ent.name === 'coverage' || ent.name === '.git') continue;
      walk(p, onFile);
    } else if (ent.isFile()) {
      onFile(p);
    }
  }
}

function truncate(s, n = 600) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + ' …' : s;
}

const sink = createTripleSink();
const { emit } = sink;

const fileIndex = buildInternalFileIndex();
console.log(`[github] Indexed ${fileIndex.size} internal source files for PR/commit cross-linking.`);

// ── Repository node ──────────────────────────────────────────
const repoUri = Github.uri.repo(OWNER, REPO_NAME);
emit(uri(repoUri), uri(Common.type), uri(Github.T.Repository));
emit(uri(repoUri), uri(Common.name), lit(REPO));
emit(uri(repoUri), uri(Common.label), lit(REPO));
emit(uri(repoUri), uri(Github.P.url), lit(`https://github.com/${REPO}`));

function upsertUser(login) {
  if (!login) return null;
  const userUri = Github.uri.user(login);
  emit(uri(userUri), uri(Common.type), uri(Github.T.User));
  emit(uri(userUri), uri(Common.name), lit(login));
  emit(uri(userUri), uri(Common.label), lit(login));
  emit(uri(userUri), uri(Github.P.url), lit(`https://github.com/${login}`));
  return userUri;
}

// ── PRs ───────────────────────────────────────────────────────
console.log(`[github] Fetching ${N_PRS} PRs…`);
const prs = gh(`/repos/${REPO}/pulls?state=all&per_page=${N_PRS}`);
for (const pr of prs) {
  const prUri = Github.uri.pr(OWNER, REPO_NAME, pr.number);
  emit(uri(prUri), uri(Common.type), uri(Github.T.PullRequest));
  emit(uri(prUri), uri(Common.name), lit(`#${pr.number} ${pr.title}`));
  emit(uri(prUri), uri(Common.label), lit(`#${pr.number} ${pr.title}`));
  emit(uri(prUri), uri(Github.P.number), lit(pr.number, XSD.int));
  emit(uri(prUri), uri(Github.P.state), lit(pr.state));
  emit(uri(prUri), uri(Github.P.merged), lit(pr.merged_at ? 'true' : 'false', XSD.bool));
  if (pr.merged_at) emit(uri(prUri), uri(Github.P.mergedAt), lit(pr.merged_at, XSD.dateTime));
  if (pr.closed_at) emit(uri(prUri), uri(Github.P.closedAt), lit(pr.closed_at, XSD.dateTime));
  emit(uri(prUri), uri(Github.P.url), lit(pr.html_url));
  emit(uri(prUri), uri(Github.P.inRepo), uri(repoUri));
  if (pr.body) emit(uri(prUri), uri(Github.P.body), lit(truncate(pr.body, 800)));

  const authorUri = upsertUser(pr.user?.login);
  if (authorUri) emit(uri(prUri), uri(Github.P.authoredBy), uri(authorUri));

  for (const lbl of pr.labels ?? []) {
    const labelUri = Github.uri.label(OWNER, REPO_NAME, lbl.name);
    emit(uri(labelUri), uri(Common.type), uri(Github.T.Label));
    emit(uri(labelUri), uri(Common.label), lit(lbl.name));
    emit(uri(prUri), uri(Github.P.hasLabel), uri(labelUri));
  }

  // Files changed (separate endpoint — pulls/:num/files)
  try {
    const files = gh(`/repos/${REPO}/pulls/${pr.number}/files?per_page=100`);
    emit(uri(prUri), uri(Github.P.changedFiles), lit(files.length, XSD.int));
    let additions = 0, deletions = 0;
    for (const f of files) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
      const internalUri = fileIndex.get(f.filename);
      if (internalUri) {
        emit(uri(prUri), uri(Github.P.affects), uri(internalUri));
      }
    }
    emit(uri(prUri), uri(Github.P.additions), lit(additions, XSD.int));
    emit(uri(prUri), uri(Github.P.deletions), lit(deletions, XSD.int));
  } catch (err) {
    console.warn(`[github] PR #${pr.number} files fetch failed: ${err.message}`);
  }

  // Reviews
  try {
    const reviews = gh(`/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`);
    for (const rv of reviews) {
      const reviewUri = Github.uri.review(OWNER, REPO_NAME, pr.number, rv.id);
      emit(uri(reviewUri), uri(Common.type), uri(Github.T.Review));
      emit(uri(reviewUri), uri(Github.P.verdict), lit(rv.state?.toLowerCase() ?? 'commented'));
      const reviewerUri = upsertUser(rv.user?.login);
      if (reviewerUri) {
        emit(uri(reviewUri), uri(Github.P.authoredBy), uri(reviewerUri));
        emit(uri(prUri), uri(Github.P.reviewedBy), uri(reviewerUri));
      }
    }
  } catch (err) {
    console.warn(`[github] PR #${pr.number} reviews fetch failed: ${err.message}`);
  }
}

// ── Issues ────────────────────────────────────────────────────
console.log(`[github] Fetching ${N_ISSUES} issues…`);
const issues = gh(`/repos/${REPO}/issues?state=all&per_page=${N_ISSUES}`);
for (const iss of issues) {
  if (iss.pull_request) continue; // `gh api issues` returns PRs too; skip
  const issueUri = Github.uri.issue(OWNER, REPO_NAME, iss.number);
  emit(uri(issueUri), uri(Common.type), uri(Github.T.Issue));
  emit(uri(issueUri), uri(Common.name), lit(`#${iss.number} ${iss.title}`));
  emit(uri(issueUri), uri(Common.label), lit(`#${iss.number} ${iss.title}`));
  emit(uri(issueUri), uri(Github.P.number), lit(iss.number, XSD.int));
  emit(uri(issueUri), uri(Github.P.state), lit(iss.state));
  emit(uri(issueUri), uri(Github.P.url), lit(iss.html_url));
  emit(uri(issueUri), uri(Github.P.inRepo), uri(repoUri));
  if (iss.body) emit(uri(issueUri), uri(Github.P.body), lit(truncate(iss.body, 800)));
  const authorUri = upsertUser(iss.user?.login);
  if (authorUri) emit(uri(issueUri), uri(Github.P.authoredBy), uri(authorUri));
  if (iss.closed_at) emit(uri(issueUri), uri(Github.P.closedAt), lit(iss.closed_at, XSD.dateTime));
  for (const lbl of iss.labels ?? []) {
    const labelUri = Github.uri.label(OWNER, REPO_NAME, lbl.name);
    emit(uri(labelUri), uri(Common.type), uri(Github.T.Label));
    emit(uri(labelUri), uri(Common.label), lit(lbl.name));
    emit(uri(issueUri), uri(Github.P.hasLabel), uri(labelUri));
  }
}

// ── Commits ───────────────────────────────────────────────────
console.log(`[github] Fetching ${N_COMMITS} commits (with per-commit file lists)…`);
const commitList = gh(`/repos/${REPO}/commits?per_page=${N_COMMITS}`);
for (const c of commitList) {
  const commitUri = Github.uri.commit(OWNER, REPO_NAME, c.sha);
  emit(uri(commitUri), uri(Common.type), uri(Github.T.Commit));
  emit(uri(commitUri), uri(Github.P.sha), lit(c.sha));
  emit(uri(commitUri), uri(Common.label), lit(c.sha.slice(0, 7) + ' ' + (c.commit?.message?.split('\n')[0] ?? '')));
  emit(uri(commitUri), uri(Common.name), lit(c.sha.slice(0, 7)));
  emit(uri(commitUri), uri(Github.P.url), lit(c.html_url));
  emit(uri(commitUri), uri(Github.P.inRepo), uri(repoUri));
  if (c.commit?.message) emit(uri(commitUri), uri(Github.P.body), lit(truncate(c.commit.message, 500)));
  if (c.commit?.author?.date) emit(uri(commitUri), uri(Common.created), lit(c.commit.author.date, XSD.dateTime));
  const authorUri = upsertUser(c.author?.login ?? c.commit?.author?.name);
  if (authorUri) emit(uri(commitUri), uri(Github.P.authoredBy), uri(authorUri));
  for (const parent of c.parents ?? []) {
    const parentUri = Github.uri.commit(OWNER, REPO_NAME, parent.sha);
    emit(uri(commitUri), uri(Github.P.parentCommit), uri(parentUri));
  }
  // Per-commit files
  try {
    const detail = gh(`/repos/${REPO}/commits/${c.sha}`);
    for (const f of detail.files ?? []) {
      const internalUri = fileIndex.get(f.filename);
      if (internalUri) {
        emit(uri(commitUri), uri(Github.P.affects), uri(internalUri));
      }
    }
  } catch (err) {
    console.warn(`[github] commit ${c.sha.slice(0, 7)} detail fetch failed: ${err.message}`);
  }
}

console.log(`[github] Produced ${sink.size()} triples.`);

if (OUT_FILE) {
  const nt = sink.triples.map(t => `${t.subject} ${t.predicate} ${t.object} .`).join('\n') + '\n';
  fs.writeFileSync(OUT_FILE, nt);
  console.log(`[github] Wrote ${sink.size()} triples to ${OUT_FILE}`);
}

if (DRY_RUN) {
  console.log('[github] --dry-run set; not importing.');
  process.exit(0);
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });
const { cgId } = await client.ensureProject({
  id: PROJECT_ID,
  name: args.name ?? 'DKG Code memory',
  description: 'Shared context graph for the dkg-v9 monorepo itself.',
});
await client.ensureSubGraph(cgId, SUBGRAPH);
await client.writeAssertion(
  {
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    triples: sink.triples,
  },
  { label: 'github' },
);
console.log(`[github] Done. Imported ${sink.size()} triples into ${cgId}/${SUBGRAPH}/${ASSERTION_NAME}.`);
