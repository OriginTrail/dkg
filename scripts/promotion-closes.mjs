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
import {
  extractClosingRefs,
  formatClosesBlock,
  parseMergedPrNumbers,
} from './lib/promotion-closes.mjs';

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

function main() {
  const base = process.argv[2] ?? 'origin/main';
  const head = process.argv[3] ?? 'origin/testnet-canary';

  const subjects = run('git', ['log', '--format=%s', `${base}..${head}`], `git log ${base}..${head}`);
  const prs = parseMergedPrNumbers(subjects);
  if (prs.length === 0) {
    process.stderr.write(`(no merged PRs in ${base}..${head})\n`);
    return;
  }

  const entries = [];
  for (const pr of prs) {
    const body = run(
      'gh',
      ['pr', 'view', String(pr), '--repo', REPO, '--json', 'body', '--jq', '.body // ""'],
      `gh pr view ${pr}`,
    );
    for (const issue of extractClosingRefs(body)) {
      const state = run(
        'gh',
        ['issue', 'view', String(issue), '--repo', REPO, '--json', 'state', '--jq', '.state'],
        `gh issue view ${issue}`,
      ).trim();
      // Only filter on a state we positively established. Anything else has
      // already thrown above.
      if (state === 'OPEN') entries.push({ issue, pr });
    }
  }

  const block = formatClosesBlock(entries);
  if (block) process.stdout.write(block + '\n');
  else process.stderr.write('(no still-open issues referenced by the promoted PRs)\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`promotion-closes: ${err.message}\n`);
  process.exit(1);
}
