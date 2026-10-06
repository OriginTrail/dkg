#!/usr/bin/env node

// Fetches the trusted CI controller revision the workflows pin, so tests that
// read the pinned controller's files from git history also run in a shallow
// checkout. The ref comes from the canonical pin validator, not workflow text.
// It also fetches the protected branches back past the pin, so the provenance
// test can require the pin to be on their history. A failed fetch fails the
// script.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateTrustedControllerPins } from './trusted-controller-pins.mjs';
import { TESTNET_CANARY_ROLLOUT_POLICY } from './validate-delta-rollout-ruleset.mjs';

export const PINNED_WORKFLOWS = Object.freeze(['ci.yml', 'evm-integration.yml']);
// The pin must already be on one of these branches, as fetched from origin.
export const PROTECTED_BRANCHES = TESTNET_CANARY_ROLLOUT_POLICY.controllerBranches;
// How far before the pin's commit date the fetched history reaches, for
// descendants committed on a clock that ran behind the pin's.
export const PROTECTED_HISTORY_MARGIN_SECONDS = 24 * 60 * 60;
// How many generations each cut point of the fetched history is deepened by,
// one fetch per entry, while the pin is still out of reach.
export const PROTECTED_HISTORY_DEEPEN_STEPS = Object.freeze([1, 4, 16, 64]);

export function pinnedControllerRef(
  readWorkflow = (name) => fs.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'),
) {
  return validateTrustedControllerPins(
    PINNED_WORKFLOWS.map((name) => ({ sourceName: name, source: readWorkflow(name) })),
  ).ref;
}

// A depth-limited fetch into a complete clone would make it shallow and hide
// the history it cuts off, so only an already-shallow checkout (CI's) gets one.
export function isShallowRepository(run = execFileSync) {
  return run('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true';
}

export function fetchPinnedController({
  run = execFileSync,
  ref = pinnedControllerRef(),
  shallow = isShallowRepository(run),
} = {}) {
  run('git', ['fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', ref], { stdio: 'inherit' });
}

function commitDate(run, revision) {
  const date = Number(run('git', ['log', '-1', '--format=%ct', revision], { encoding: 'utf8' }).trim());
  if (!Number.isSafeInteger(date)) throw new Error(`cannot read the commit date of ${revision}`);
  return date;
}

const remoteBranch = (branch) => `refs/remotes/origin/${branch}`;
const refspecs = (branches) => branches.map((branch) => `+refs/heads/${branch}:${remoteBranch(branch)}`);

// Fetches the protected branches into refs/remotes/origin/*. A shallow
// checkout gets each tip first. Each branch whose tip is no older than the
// margin before the pin's commit date is then deepened back to that point;
// an older tip cannot contain the pin, and deepening it would fetch the
// branch's whole history.
//
// A date-limited fetch cuts every commit with a parent older than the limit,
// and git then hides all of that commit's parents, not only the old one. A
// merge of a pull request branch last pushed before the limit, landing on the
// branch after the pin, therefore hides the pin whenever the pin is that
// merge's first parent. While the pin is out of reach, each cut point is
// deepened by a growing number of generations, to a bounded total. The
// date-limited fetch also lists cut points whose commits it never sent, and
// git refuses to deepen while such an entry is in .git/shallow, so the
// entries for missing commits are pruned before each step, without expiring
// any object: the pin is reachable from no ref until a step reaches it, and
// the tests read its files. A pin that is still unreachable after the last
// step is left for the provenance test to report, as it was before these
// steps existed.
export function fetchProtectedHistory({
  run = execFileSync,
  ref = pinnedControllerRef(),
  shallow = isShallowRepository(run),
  reachable = (commit) => protectedBranchContaining(commit) !== undefined,
} = {}) {
  const fetch = (options, branches) => run(
    'git',
    ['fetch', '--no-tags', ...options, 'origin', ...refspecs(branches)],
    { stdio: 'inherit' },
  );
  if (!shallow) {
    fetch([], PROTECTED_BRANCHES);
    return;
  }
  const since = commitDate(run, ref) - PROTECTED_HISTORY_MARGIN_SECONDS;
  fetch(['--depth=1'], PROTECTED_BRANCHES);
  const recent = PROTECTED_BRANCHES.filter((branch) => commitDate(run, remoteBranch(branch)) >= since);
  if (recent.length === 0) return;
  fetch([`--shallow-since=${since}`], recent);
  for (const generations of PROTECTED_HISTORY_DEEPEN_STEPS) {
    if (reachable(ref)) return;
    run('git', ['prune', '--expire=never'], { stdio: 'inherit' });
    fetch([`--deepen=${generations}`], recent);
  }
}

// The first protected branch whose fetched history contains `commit`. Any git
// failure, such as a missing branch or commit, counts as not containing it.
export function protectedBranchContaining(commit, { cwd } = {}) {
  return PROTECTED_BRANCHES.find((branch) => spawnSync(
    'git',
    ['merge-base', '--is-ancestor', commit, remoteBranch(branch)],
    { cwd, stdio: 'ignore' },
  ).status === 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ref = pinnedControllerRef();
  const shallow = isShallowRepository();
  fetchPinnedController({ ref, shallow });
  fetchProtectedHistory({ ref, shallow });
}
