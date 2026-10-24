#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Execution settings only. The immutable planner still owns lane selection. */
export function resolveCiProfile({ eventName, profile = '', seed = '', runNumber = '' }) {
  if (profile && !['standard', 'nightly-equivalent'].includes(profile)) throw new Error(`Unknown CI profile: ${profile}`);
  if (eventName !== 'workflow_dispatch' && (profile || seed)) throw new Error('Profile/seed inputs require workflow_dispatch');
  const name = eventName === 'schedule' ? 'nightly-equivalent' : profile || 'standard';
  const nightly = name === 'nightly-equivalent';
  const actualSeed = seed || (nightly ? String(runNumber) : '640905');
  if (!/^-?(0|[1-9]\d*)$/.test(actualSeed) || !Number.isSafeInteger(Number(actualSeed))
    || Number(actualSeed) < -2147483648 || Number(actualSeed) > 2147483647) {
    throw new Error('Property seed must be a signed 32-bit decimal integer');
  }
  return { schemaVersion: 1, profile: name, seed: Number(actualSeed), requestedTrials: nightly ? 1000 : 100, managedLocal: nightly };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const profile = resolveCiProfile({ eventName: process.env.EVENT_NAME, profile: process.env.PROFILE_INPUT,
    seed: process.env.SEED_INPUT, runNumber: process.env.GITHUB_RUN_NUMBER });
  const subject = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(subject) || subject !== process.env.GITHUB_SHA) throw new Error('Profile subject differs from workflow commit');
  const record = { ...profile, repository: process.env.GITHUB_REPOSITORY, subject,
    workflow: process.env.GITHUB_WORKFLOW, runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT, resolvedAt: new Date().toISOString() };
  console.log(JSON.stringify(record));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({
    profile: record.profile, profile_json: JSON.stringify(record),
  }).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nExecution profile: **${record.profile}**; commit \`${subject}\`; seed \`${record.seed}\`; requested trials **${record.requestedTrials}**; managed local **${record.managedLocal}**.\n`);
}
