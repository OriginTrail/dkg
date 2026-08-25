import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canonicalIssueRefs,
  extractClosingRefs,
  formatClosesBlock,
  parseMergedPrNumbers,
  stripHtmlComments,
} from '../promotion-closes.mjs';
import { DEFAULT_BASE, DEFAULT_HEAD } from '../../promotion-closes.mjs';

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

test('parseMergedPrNumbers covers squash-merge subjects too', () => {
  // This repo has allow_merge_commit AND allow_squash_merge enabled, and both
  // appear in testnet-canary's history. Parsing only the merge form silently
  // dropped every squash-merged PR (PR #2327 review).
  const log = [
    'refactor(2305): derive the Kafka plugin context from the canonical daemon context (#2307)',
    'fix(2270): admission ownership for every enqueue path, and one clear policy (#2303)',
    'Merge pull request #2131 from OriginTrail/fix/x',
  ].join('\n');
  assert.deepEqual(parseMergedPrNumbers(log), [2131, 2303, 2307]);
});

test('parseMergedPrNumbers ignores a mid-subject issue reference', () => {
  // Only a trailing `(#N)` is a squash marker; `fix(#12) something` is not.
  assert.deepEqual(parseMergedPrNumbers('fix(#12) something else'), []);
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

test('extractClosingRefs ignores keywords hidden in HTML comments', () => {
  // .github/PULL_REQUEST_TEMPLATE.md ships this line verbatim, and 15 merged
  // PRs still carry it. GitHub does not treat it as an active reference, and
  // emitting `Closes #123` from it would close an unrelated issue on promotion
  // (PR #2327 review).
  const template = '<!-- Link any related issues: Fixes #123, Relates to #456 -->';
  assert.deepEqual(extractClosingRefs(template), []);
  // A real reference alongside the template comment still counts.
  assert.deepEqual(extractClosingRefs(template + '\n\nCloses #77'), [77]);
});

test('extractClosingRefs ignores a multiline commented-out block', () => {
  const body = ['<!--', 'Closes #1', 'Fixes #2', '-->', 'Closes #3'].join('\n');
  assert.deepEqual(extractClosingRefs(body), [3]);
});

test('stripHtmlComments leaves visible text intact', () => {
  assert.equal(stripHtmlComments('a <!-- x --> b').replace(/\s+/g, ' ').trim(), 'a b');
  assert.equal(stripHtmlComments(null), '');
});

test('canonicalIssueRefs resolves each issue once, attributed to the first PR', () => {
  const map = canonicalIssueRefs([
    { pr: 20, body: 'Closes #5' },
    { pr: 3, body: 'Closes #5\nFixes #9' },
    { pr: 11, body: 'Resolves #9' },
  ]);
  assert.deepEqual([...map.entries()], [[5, 3], [9, 3]]);
});

test('canonicalIssueRefs ignores commented references', () => {
  assert.deepEqual([...canonicalIssueRefs([{ pr: 1, body: '<!-- Fixes #123 -->' }]).entries()], []);
});

test('the CLI defaults match the documented workflow', () => {
  // `pnpm run promotion:closes` takes no arguments, so a typo in either
  // default would break the advertised command with nothing failing.
  assert.equal(DEFAULT_BASE, 'origin/main');
  assert.equal(DEFAULT_HEAD, 'origin/testnet-canary');
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

test('formatClosesBlock is a pure formatter — dedup happens upstream', () => {
  // canonicalIssueRefs owns dedup now, so the formatter renders what it is
  // given and the CLI performs exactly one issue lookup per unique issue.
  assert.equal(
    formatClosesBlock([{ issue: 9, pr: 1 }]),
    'Closes #9  <!-- shipped in PR #1 -->',
  );
});

test('formatClosesBlock returns empty string for no entries', () => {
  assert.equal(formatClosesBlock([]), '');
});

// ── CLI: failures must abort, not silently shorten the block ───────────────
//
// PR #2327 review — the stub used to answer on `$1` alone and ignore the rest
// of argv, so a regression in the `gh` arguments would have passed. Dropping
// `--jq .state`, for instance, makes real `gh` emit `{"state":"OPEN"}` instead
// of `OPEN`, the comparison fails, and the issue is silently omitted. The stub
// now asserts the FULL argument list and records argv for inspection.
function withStubGh({ prExit = 0, issueExit = 0, issueState = 'OPEN', prBody = 'Closes #123', log = 'Merge pull request #11 from x/y' } = {}) {
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
  for (const subject of log.split('\n')) git('commit', '-q', '--allow-empty', '-m', subject);

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const argvLog = path.join(dir, 'argv.log');

  // The stub demands the exact contract the parser consumes: scalar body text
  // and a scalar state string. Anything else exits 97 and fails the run.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(argvLog)}
case "$1 $2" in
  "pr view")
    [ "$4" = "--repo" ] || exit 97
    [ "$6" = "--json" ] && [ "$7" = "body" ] || exit 97
    [ "$8" = "--jq" ] || exit 97
    case "$9" in *".body"*) ;; *) exit 97 ;; esac
    [ ${prExit} -ne 0 ] && { echo "boom" >&2; exit ${prExit}; }
    printf '%s\\n' ${JSON.stringify(prBody)}
    exit 0 ;;
  "issue view")
    [ "$4" = "--repo" ] || exit 97
    [ "$6" = "--json" ] && [ "$7" = "state" ] || exit 97
    [ "$8" = "--jq" ] && [ "$9" = ".state" ] || exit 97
    [ ${issueExit} -ne 0 ] && { echo "boom" >&2; exit ${issueExit}; }
    echo "${issueState}"
    exit 0 ;;
esac
exit 97
`,
    { mode: 0o755 },
  );
  const res = spawnSync('node', [CLI, 'HEAD~' + log.split('\n').length, 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO: 'o/r' },
  });
  const argv = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, argv };
}

test('CLI emits the block when both lookups succeed', () => {
  const res = withStubGh();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Closes #123 {2}<!-- shipped in PR #11 -->$/m);
});

test('CLI requests the body and state in the exact scalar form its parser consumes', () => {
  // The stub exits 97 on any other argument list, so a green run IS the
  // assertion; these make the contract explicit in the failure message.
  const res = withStubGh();
  assert.equal(res.status, 0, `gh contract violated: ${res.stderr}`);
  assert.ok(res.argv.some((l) => l.includes('pr view 11') && l.includes('--json body') && l.includes('.body')), res.argv.join(' | '));
  assert.ok(res.argv.some((l) => l.includes('issue view 123') && l.includes('--json state') && l.includes('--jq .state')), res.argv.join(' | '));
});

test('CLI discovers squash-merged PRs too', () => {
  const res = withStubGh({ log: 'refactor(x): thing (#11)' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Closes #123 {2}<!-- shipped in PR #11 -->/);
});

test('CLI ignores closing keywords hidden in an HTML comment', () => {
  const res = withStubGh({ prBody: '<!-- Link any related issues: Fixes #123 -->' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '');
  assert.match(res.stderr, /no still-open issues/);
});

test('CLI looks an issue up ONCE even when several PRs reference it', () => {
  const res = withStubGh({ log: 'Merge pull request #11 from a/b\nMerge pull request #12 from a/c' });
  assert.equal(res.status, 0, res.stderr);
  const issueLookups = res.argv.filter((l) => l.startsWith('issue view 123'));
  assert.equal(issueLookups.length, 1, `expected 1 issue lookup, got ${issueLookups.length}`);
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
