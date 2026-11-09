#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateResolvedProfile } from './resolve-ci-profile.mjs';

/** One conversion at the runner boundary, shared by tests and coverage metadata. */
export function profileEnvironment(record) {
  validateResolvedProfile(record);
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
