#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCiProfile } from './resolve-ci-profile.mjs';

/** One conversion at the runner boundary, shared by tests and coverage metadata. */
export function profileEnvironment(record) {
  if (!record || record.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(record.subject ?? '')
    || !['standard', 'nightly-equivalent'].includes(record.profile) || !Number.isInteger(record.seed)) {
    throw new Error('Missing/invalid resolved execution profile');
  }
  const settings = resolveCiProfile({ eventName: 'workflow_dispatch', profile: record.profile, seed: String(record.seed) });
  if (record.requestedTrials !== settings.requestedTrials || record.managedLocal !== settings.managedLocal) {
    throw new Error('Resolved execution profile has inconsistent settings');
  }
  return {
    DKG_PROPERTY_RUNS: String(record.requestedTrials), DKG_PROPERTY_SEED: String(record.seed),
    DKG_CI_PROFILE: record.profile, DKG_CI_SUBJECT: record.subject,
    PW_DEVNET_LOCAL: record.managedLocal ? '1' : '0',
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const env = profileEnvironment(JSON.parse(process.env.PROFILE_JSON || 'null'));
  if (env.DKG_CI_SUBJECT !== process.env.GITHUB_SHA) throw new Error('Execution profile does not match workflow commit');
  if (!process.env.GITHUB_ENV) throw new Error('Missing GITHUB_ENV');
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''));
}
