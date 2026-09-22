#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
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

const changeEntries = values['changes-z']
  ? parseNameStatusZ(fs.readFileSync(values['changes-z']))
  : [];
const labels = JSON.parse(values['labels-json']) ?? [];
if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
  throw new TypeError('--labels-json must contain a JSON string array');
}

// The workflow exports the candidate checkout and the two diffed commits as
// environment variables (not flags, which an older pinned controller would
// reject). Reading blobs is data-only: `git cat-file blob` applies no
// filters and runs nothing from the merge candidate. Without all three, the
// planner receives no reader and every workspace manifest edit stays full.
function manifestReaderFromEnvironment(environment) {
  const repository = environment.CI_CANDIDATE_REPO;
  const commits = {
    base: environment.CI_DIFF_BASE_SHA,
    head: environment.CI_DIFF_HEAD_SHA,
  };
  const isObjectId = (value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? '');
  if (!repository || !isObjectId(commits.base) || !isObjectId(commits.head)) return undefined;
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
  readManifest: manifestReaderFromEnvironment(process.env),
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
