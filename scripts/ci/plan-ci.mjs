#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  MANIFEST_READER_ENV,
  githubOutputsForPlan,
  parseNameStatusZ,
  planCi,
  renderPlanSummary,
} from '../lib/ci-delta.mjs';

const { values } = parseArgs({
  options: {
    event: { type: 'string' },
    'changes-z': { type: 'string' },
    'labels-json': { type: 'string', default: '[]' },
    'github-output': { type: 'string' },
    summary: { type: 'string' },
  },
  strict: true,
});

if (!values.event) throw new Error('--event is required');

const changes = values['changes-z'] ? fs.readFileSync(values['changes-z']) : Buffer.alloc(0);
const changeEntries = parseNameStatusZ(changes);
const labels = JSON.parse(values['labels-json']) ?? [];
if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
  throw new TypeError('--labels-json must contain a JSON string array');
}

// The workflow exports the candidate checkout and the two diffed commits as
// environment variables (not flags, which an older pinned controller would
// reject). Reading blobs is data-only: `git cat-file blob` applies no
// filters and runs nothing from the merge candidate. The head must be the
// checked-out candidate, the base its first parent, and the change list being
// routed exactly their `git diff --name-status -z`, as the workflows compute
// it; otherwise, or without all three variables, the planner receives no
// reader and every workspace manifest edit stays full. This keeps the
// comparison consistent with the routed diff. It cannot defend against a
// pull-request workflow that rewrites all of its own inputs, which could
// narrow the plan without the reader; workflow edits route to full CI.
function manifestReaderFromEnvironment(environment, routedChanges) {
  const repository = environment[MANIFEST_READER_ENV.repository];
  const commits = {
    base: environment[MANIFEST_READER_ENV.base],
    head: environment[MANIFEST_READER_ENV.head],
  };
  const isObjectId = (value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? '');
  if (!repository || !isObjectId(commits.base) || !isObjectId(commits.head)) return undefined;
  const revision = (name) => execFileSync(
    'git',
    ['-C', repository, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  try {
    if (revision('HEAD') !== commits.head || revision(`${commits.head}^1`) !== commits.base) return undefined;
    const diff = execFileSync(
      'git',
      ['-C', repository, 'diff', '--name-status', '-z', commits.base, commits.head],
      { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (!diff.equals(routedChanges)) return undefined;
  } catch {
    return undefined;
  }
  return (side, filePath) => execFileSync(
    'git',
    ['-C', repository, 'cat-file', 'blob', `${commits[side]}:${filePath}`],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const plan = planCi({
  eventName: values.event,
  changeEntries,
  labels,
  readManifest: manifestReaderFromEnvironment(process.env, changes),
});

if (values['github-output']) {
  const output = Object.entries(githubOutputsForPlan(plan))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.appendFileSync(values['github-output'], `${output}\n`);
}

if (values.summary) {
  fs.appendFileSync(values.summary, renderPlanSummary(plan));
}

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
