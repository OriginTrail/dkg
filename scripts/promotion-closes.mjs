#!/usr/bin/env node
/**
 * Print the `Closes #N` block for a `testnet-canary` -> `main` promotion PR.
 *
 *   node scripts/promotion-closes.mjs [base] [head]
 *   pnpm run promotion:closes
 *
 * Defaults to `origin/main..origin/testnet-canary`. See CONTRIBUTING.md
 * ("Promoting testnet-canary to main") for why this is necessary.
 *
 * Every GitHub lookup is checked. A network error, auth failure or rate limit
 * ABORTS with a non-zero exit rather than silently emitting a short block —
 * a partial block that looks complete would recreate the very backlog this
 * command exists to prevent.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  canonicalIssueRefs,
  formatClosesBlock,
  parseMergedPrNumbers,
} from './lib/promotion-closes.mjs';

export const DEFAULT_BASE = 'origin/main';
export const DEFAULT_HEAD = 'origin/testnet-canary';

const REPO = process.env.REPO ?? 'OriginTrail/dkg';

function run(cmd, args, what) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(
      `${what} failed (exit ${res.status}): ${(res.stderr || res.stdout || '').trim().slice(0, 400)}`,
    );
  }
  return res.stdout;
}

/** `gh pr view <n> --json body --jq .body` — scalar body text. */
function prBody(pr) {
  return run(
    'gh',
    ['pr', 'view', String(pr), '--repo', REPO, '--json', 'body', '--jq', '.body // ""'],
    `gh pr view ${pr}`,
  );
}

/** `gh issue view <n> --json state --jq .state` — scalar state string. */
function issueState(issue) {
  return run(
    'gh',
    ['issue', 'view', String(issue), '--repo', REPO, '--json', 'state', '--jq', '.state'],
    `gh issue view ${issue}`,
  ).trim();
}

function main() {
  const base = process.argv[2] ?? DEFAULT_BASE;
  const head = process.argv[3] ?? DEFAULT_HEAD;

  // --first-parent is load-bearing. PRs merge directly into the promoted
  // branch, so its first-parent history is exactly the merge/squash commits.
  // Walking every commit descends INTO each merged PR, where topic-commit
  // subjects like `fix(ui): export … (#1763)` carry an ISSUE number in the same
  // trailing `(#N)` position a squash merge uses — so #1763 was being treated
  // as a promoted PR. `gh pr view 1763` then aborts the run (it is an issue),
  // or worse silently pulls closing refs from an unrelated PR that happens to
  // share the number.
  const subjects = run(
    'git',
    ['log', '--first-parent', '--format=%s', `${base}..${head}`],
    `git log --first-parent ${base}..${head}`,
  );
  const prs = parseMergedPrNumbers(subjects);
  if (prs.length === 0) {
    process.stderr.write(`(no merged PRs in ${base}..${head})\n`);
    return;
  }

  // Phase 1 — collect bodies, then canonicalise so each issue is resolved once
  // no matter how many PRs referenced it.
  const bodies = prs.map((pr) => ({ pr, body: prBody(pr) }));
  const canonical = canonicalIssueRefs(bodies);

  // Phase 2 — one state lookup per UNIQUE issue.
  const entries = [];
  for (const [issue, pr] of canonical) {
    // Only filter on a state positively established; anything else threw above.
    if (issueState(issue) === 'OPEN') entries.push({ issue, pr });
  }

  const block = formatClosesBlock(entries);
  if (block) process.stdout.write(block + '\n');
  else process.stderr.write('(no still-open issues referenced by the promoted PRs)\n');
}

// Only run when invoked directly. The test suite imports DEFAULT_BASE /
// DEFAULT_HEAD to pin the documented no-argument workflow, and importing this
// module must not shell out to git and gh.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`promotion-closes: ${err.message}\n`);
    process.exit(1);
  }
}
