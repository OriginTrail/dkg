import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  extractClosingRefs,
  formatClosesBlock,
  parseMergedPrNumbers,
} from '../promotion-closes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../../promotion-closes.mjs');

// ── merge-subject discovery ────────────────────────────────────────────────
test('parseMergedPrNumbers picks up merge subjects only', () => {
  const log = [
    'Merge pull request #2131 from OriginTrail/fix/1763-mock-subgraphs-export',
    'fix(ui): address PR #2131 review — not a merge subject',
    'Merge pull request #2132 from OriginTrail/test/1486-coverage',
    "Merge branch 'testnet-canary' into fix/1763-mock-subgraphs-export",
  ].join('\n');
  assert.deepEqual(parseMergedPrNumbers(log), [2131, 2132]);
});

test('parseMergedPrNumbers dedupes and sorts', () => {
  const log = 'Merge pull request #20 from a\nMerge pull request #3 from b\nMerge pull request #20 from a';
  assert.deepEqual(parseMergedPrNumbers(log), [3, 20]);
});

test('parseMergedPrNumbers tolerates empty and nullish input', () => {
  assert.deepEqual(parseMergedPrNumbers(''), []);
  assert.deepEqual(parseMergedPrNumbers(null), []);
  assert.deepEqual(parseMergedPrNumbers(undefined), []);
});

// ── closing-keyword extraction ─────────────────────────────────────────────
test('extractClosingRefs handles every keyword spelling', () => {
  for (const kw of ['Close', 'Closes', 'Closed', 'Fix', 'Fixes', 'Fixed', 'Resolve', 'Resolves', 'Resolved']) {
    assert.deepEqual(extractClosingRefs(`${kw} #7`), [7], kw);
    assert.deepEqual(extractClosingRefs(`${kw.toLowerCase()} #7`), [7], kw.toLowerCase());
  }
});

test('extractClosingRefs accepts the colon form GitHub also honours', () => {
  // Present in this repo's own history (PRs #933, #940, #943).
  assert.deepEqual(extractClosingRefs('fixes: #937'), [937]);
  assert.deepEqual(extractClosingRefs('Closes: #12'), [12]);
  assert.deepEqual(extractClosingRefs('Fixes:#12'), [12]);
});

test('extractClosingRefs finds refs across a multiline body', () => {
  const body = [
    '## Summary', '', 'Does a thing.', '',
    'Closes #101', 'Fixes: #102', '', 'Resolved #103', '',
    '🤖 Generated with Claude Code',
  ].join('\n');
  assert.deepEqual(extractClosingRefs(body), [101, 102, 103]);
});

test('extractClosingRefs dedupes repeated references', () => {
  assert.deepEqual(extractClosingRefs('Closes #5\nFixes #5\nresolves #5'), [5]);
});

test('extractClosingRefs tolerates a null or empty body', () => {
  assert.deepEqual(extractClosingRefs(null), []);
  assert.deepEqual(extractClosingRefs(undefined), []);
  assert.deepEqual(extractClosingRefs(''), []);
});

test('extractClosingRefs ignores bare references with no keyword', () => {
  assert.deepEqual(extractClosingRefs('See #99 and PR #100 for context'), []);
  assert.deepEqual(extractClosingRefs('follow-up to #42'), []);
});

test('extractClosingRefs does not match a keyword inside another word', () => {
  assert.deepEqual(extractClosingRefs('prefix #12'), []);
  assert.deepEqual(extractClosingRefs('unclosed #12'), []);
});

test('extractClosingRefs is not order-dependent across calls (lastIndex reset)', () => {
  assert.deepEqual(extractClosingRefs('Closes #1'), [1]);
  assert.deepEqual(extractClosingRefs('Closes #2'), [2]);
  assert.deepEqual(extractClosingRefs('Closes #3'), [3]);
});

// ── formatting ─────────────────────────────────────────────────────────────
test('formatClosesBlock renders one sorted line per issue', () => {
  assert.equal(
    formatClosesBlock([{ issue: 20, pr: 2 }, { issue: 3, pr: 1 }]),
    'Closes #3  <!-- shipped in PR #1 -->\nCloses #20  <!-- shipped in PR #2 -->',
  );
});

test('formatClosesBlock keeps the first PR that claimed an issue', () => {
  assert.equal(
    formatClosesBlock([{ issue: 9, pr: 1 }, { issue: 9, pr: 5 }]),
    'Closes #9  <!-- shipped in PR #1 -->',
  );
});

test('formatClosesBlock returns empty string for no entries', () => {
  assert.equal(formatClosesBlock([]), '');
});

// ── CLI: failures must abort, not silently shorten the block ───────────────
function withStubGh({ prExit = 0, issueExit = 0, issueState = 'OPEN' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-closes-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'f'), '1');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('commit', '-q', '--allow-empty', '-m', 'Merge pull request #11 from x/y');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
if [ "$1" = "pr" ]; then
  [ ${prExit} -ne 0 ] && { echo "boom" >&2; exit ${prExit}; }
  echo "Closes #123"
  exit 0
fi
if [ "$1" = "issue" ]; then
  [ ${issueExit} -ne 0 ] && { echo "boom" >&2; exit ${issueExit}; }
  echo "${issueState}"
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  const res = spawnSync('node', [CLI, 'HEAD~1', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO: 'o/r' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test('CLI emits the block when both lookups succeed', () => {
  const res = withStubGh({});
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Closes #123 {2}<!-- shipped in PR #11 -->$/m);
});

test('CLI aborts when the PR lookup fails, rather than emitting a short block', () => {
  const res = withStubGh({ prExit: 1 });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /gh pr view 11 failed/);
  assert.equal(res.stdout.trim(), '');
});

test('CLI aborts when the issue-state lookup fails', () => {
  const res = withStubGh({ issueExit: 1 });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /gh issue view 123 failed/);
  assert.equal(res.stdout.trim(), '');
});

test('CLI omits an issue that is positively established as CLOSED', () => {
  const res = withStubGh({ issueState: 'CLOSED' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '');
  assert.match(res.stderr, /no still-open issues/);
});
