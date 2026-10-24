#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIFECYCLE_FILE = 'devnet-local/wm-swm-vm-lifecycle.devnet.spec.ts';
export const LIFECYCLE_TESTS = [
  'creates WM assertion on devnet CG',
  'promotes assertion to SWM',
  'full WM → SWM → VM pipeline mints a confirmed on-chain kaId',
  'published entity label appears in VM layer after refresh',
  'operations view loads after publish activity',
  'update endpoint requires a precomputed attestation for on-chain update',
];
export const LIFT_TEST = 'generated claim, validate, finalize and restart sequences preserve durable lifecycle state';

export function browserExecutions(report) {
  const tests = [];
  function visit(suite, parents = []) {
    const titles = [...parents, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      tests.push({ file: spec.file, title: spec.title, identity: [...titles, spec.title].join(' > '),
        project: test.projectName, expectedStatus: test.expectedStatus,
        attempts: (test.results ?? []).map(({ status, duration, startTime, retry }) => ({ status, durationMs: duration, startTime, retry })) });
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  visit(report);
  return tests;
}

/** Collect every error: missing UI evidence must not hide a publisher failure. */
export function summarizeNightlyProfile({ profile, needs, browsers = [], campaigns = [], now = new Date().toISOString() }) {
  const errors = [];
  const summary = { schemaVersion: 1, ...profile, recordedAt: now, status: 'failed', errors,
    jobs: Object.fromEntries(Object.entries(needs).map(([key, value]) => [key, value.result])),
    browsers, campaigns };
  if (!profile || profile.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(profile.subject ?? '')) errors.push('Missing/invalid resolved profile identity');
  for (const [job, state] of Object.entries(needs)) {
    if (['failure', 'cancelled'].includes(state.result)) errors.push(`${job}: ${state.result}`);
  }
  if (needs.changes?.result !== 'success') errors.push('Profile planning did not succeed');
  if (profile?.profile === 'nightly-equivalent') {
    if (profile.requestedTrials !== 1000 || profile.managedLocal !== true) errors.push('Nightly settings are incomplete');
    for (const job of ['tornado-publisher', 'kosava-node-ui-e2e']) {
      if (needs[job]?.result !== 'success') errors.push(`Required ${job} execution did not succeed`);
    }
    for (let shard = 1; shard <= 7; shard++) {
      const rows = browsers.filter(row => row.shard === shard);
      if (rows.length !== 1) { errors.push(`Missing/duplicate browser shard ${shard}/7`); continue; }
      const row = rows[0];
      if (row.runtime?.subject !== profile.subject || row.runtime?.profile !== profile.profile
        || row.runtime?.managedLocal !== true || Number(row.runtime?.seed) !== profile.seed
        || Number(row.runtime?.requestedTrials) !== profile.requestedTrials
        || row.runtime?.runId !== profile.runId) errors.push(`Browser shard ${shard} does not match the resolved profile`);
      if (row.errors?.length) errors.push(`Browser shard ${shard} has runner errors`);
      if (!row.tests.length) errors.push(`Browser shard ${shard} discovered zero tests`);
      for (const test of row.tests) {
        const last = test.attempts.at(-1)?.status;
        if (!last || !['passed', 'skipped'].includes(last)) errors.push(`Browser execution failed/missing: ${test.identity} (${last})`);
      }
    }
    const lifecycle = browsers.flatMap(row => row.tests).filter(test => test.file?.endsWith(LIFECYCLE_FILE));
    for (const title of LIFECYCLE_TESTS) {
      const matches = lifecycle.filter(test => test.title === title && test.project === 'real-node');
      if (matches.length !== 1 || matches[0].expectedStatus !== 'passed' || matches[0].attempts.at(-1)?.status !== 'passed') {
        errors.push(`Required lifecycle scenario did not pass exactly once: ${title}`);
      }
    }
    if (campaigns.length !== 1) errors.push('Missing/duplicate lift lifecycle campaign');
    for (const campaign of campaigns) {
      if (campaign.schemaVersion !== 1 || campaign.identity !== LIFT_TEST || campaign.status !== 'passed'
        || campaign.subject !== profile.subject || campaign.seed !== profile.seed
        || campaign.requestedTrials !== 1000 || campaign.completedTrials !== 1000
        || campaign.interrupted !== false || campaign.numSkips !== 0
        || campaign.profile !== profile.profile || campaign.runId !== profile.runId || !(campaign.durationMs >= 0)) {
        errors.push('Lift lifecycle campaign failed, unfinished, or does not match the resolved profile');
      }
    }
  } else if (profile?.profile !== 'standard') errors.push('Unknown resolved profile');
  summary.status = errors.length ? 'failed' : 'passed';
  return summary;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = process.argv[2] ?? 'nightly-evidence';
  const readErrors = [];
  function read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { readErrors.push(`${file}: ${error.code ?? error.name}`); return null; }
  }
  const profile = JSON.parse(process.env.PROFILE_JSON || 'null');
  const browsers = [], campaigns = [];
  if (profile?.profile === 'nightly-equivalent') {
    for (let shard = 1; shard <= 7; shard++) {
      const artifact = `node-ui-playwright-report-${shard}-of-7`;
      const report = read(path.join(root, artifact, 'playwright-report/results.json'));
      if (report) browsers.push({ shard, artifact, startedAt: report.stats?.startTime,
        durationMs: report.stats?.duration, runtime: report.config?.metadata,
        errors: (report.errors ?? []).map(error => error.message), tests: browserExecutions(report) });
    }
    for (const entry of fs.readdirSync(root, { recursive: true })) {
      if (String(entry).endsWith('lift-lifecycle-campaign.json')) {
        const campaign = read(path.join(root, String(entry)));
        if (campaign) campaigns.push({ ...campaign, artifact: String(entry) });
      }
    }
  }
  const summary = summarizeNightlyProfile({ profile, needs: JSON.parse(process.env.NEEDS_JSON || '{}'), browsers, campaigns });
  summary.errors.push(...readErrors);
  if (summary.errors.length) summary.status = 'failed';
  fs.writeFileSync('nightly-profile-summary.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(`Profile ${summary.profile ?? 'missing'}: ${summary.status}`);
  for (const error of summary.errors) console.error(error);
  if (summary.status !== 'passed') process.exitCode = 1;
}
