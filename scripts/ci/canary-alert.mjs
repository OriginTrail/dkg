#!/usr/bin/env node
// Opens, comments on or closes the `ci-alert` issue of a finished ci.yml run's
// profile on testnet-canary (scripts/lib/canary-alert.mjs decides which). The
// canary-alert job in .github/workflows/ci.yml runs it after the CI gate of
// every push and dispatched run there, the nightly included, with the gate's
// result in CI_GATE_RESULT and the profile ci.yml resolved in CI_PROFILE.
//
// --dry-run prints the decision and the issue text for a past run without
// writing to GitHub, reading the gate result from the run itself:
//   GITHUB_TOKEN=$(gh auth token) node scripts/ci/canary-alert.mjs --dry-run --repo OriginTrail/dkg --run-id <id>
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ALERT_LABEL, alertIssue, isRed, planAlert, PROFILES, readRecovery } from '../lib/canary-alert.mjs';
import { CANARY_ALERT_JOB, CANARY_BRANCH, CI_GATE_JOB, runKind } from '../lib/ci-health.mjs';
import { createGitHubClient, ensureLabel, findOpenIssue, listRunJobs } from '../lib/github-rest.mjs';

// The profile the run executed, whose issue it writes. The live job passes the
// one ci.yml resolved (CI_PROFILE), and --profile overrides it. Only a dry run
// of a past run without either guesses from the run (runKind in ci-health.mjs:
// the dispatch nightly-ci.yml makes is the nightly, anything else standard),
// a guess blind to a manual nightly-equivalent dispatch, so the live job never
// relies on it.
export function runProfile({ option, env, live, run }) {
  const guess = live ? undefined : runKind(run) === 'nightly' ? 'nightly-equivalent' : 'standard';
  const profile = option ?? (env.CI_PROFILE || undefined) ?? guess;
  if (!PROFILES.includes(profile)) throw new Error(`needs --profile or CI_PROFILE set to ${PROFILES.join(' or ')}, not ${profile ?? 'nothing'}`);
  return profile;
}

// The newest pass that closed one of this profile's alert issues, read from
// the closed ones GitHub updated last, in one request: it cannot sort by
// closing time, but closing updates an issue. A state that cannot be read
// counts for nothing, and so does a failed lookup: the alert then opens as it
// would with no recovery on record.
export async function findLastRecovery(client, repo, profile, log = () => {}) {
  try {
    const issues = await client.request('GET', `repos/${repo}/issues`, {
      query: { labels: ALERT_LABEL.name, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 },
    });
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => readRecovery(issue.body, profile))
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  } catch (error) {
    log(`Could not read the closed ${profile} alerts (${error.message}); deciding as if none recovered.`);
    return undefined;
  }
}

function runReference(run, { attempt, profile, finishedAt, serverUrl, repo }) {
  return {
    id: run.id,
    attempt,
    profile,
    createdAt: run.created_at,
    finishedAt,
    url: attempt > 1 ? `${run.html_url}/attempts/${attempt}` : run.html_url,
    sha: run.head_sha,
    commitUrl: `${serverUrl}/${run.repository?.full_name ?? repo}/commit/${run.head_sha}`,
    event: run.event,
    actor: run.actor?.login,
    triggeringActor: run.triggering_actor?.login,
    title: String(run.head_commit?.message ?? run.display_title ?? '').split('\n')[0],
  };
}

export async function applyAlertPlan(client, repo, plan) {
  switch (plan.action) {
    case 'open': {
      await ensureLabel(client, repo, ALERT_LABEL);
      const issue = await client.request('POST', `repos/${repo}/issues`, { body: { title: plan.title, body: plan.body, labels: plan.labels } });
      return `opened #${issue.number}`;
    }
    case 'comment':
      await client.request('PATCH', `repos/${repo}/issues/${plan.issue.number}`, { body: { body: plan.body } });
      await client.request('POST', `repos/${repo}/issues/${plan.issue.number}/comments`, { body: { body: plan.comment } });
      return `commented on #${plan.issue.number}`;
    case 'close':
      await client.request('POST', `repos/${repo}/issues/${plan.issue.number}/comments`, { body: { body: plan.comment } });
      // One update records the recovery in the state and closes the issue.
      await client.request('PATCH', `repos/${repo}/issues/${plan.issue.number}`, { body: { body: plan.body, state: 'closed', state_reason: 'completed' } });
      return `closed #${plan.issue.number}`;
    default:
      return 'left the alert as it is';
  }
}

export async function runCanaryAlert({ argv = process.argv.slice(2), env = process.env, client, log = console.log } = {}) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      attempt: { type: 'string' },
      'gate-result': { type: 'string' },
      profile: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  const runId = options['run-id'] ?? env.GITHUB_RUN_ID;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^\d+$/.test(runId ?? '')) {
    throw new Error('needs GITHUB_REPOSITORY and GITHUB_RUN_ID, or --repo and --run-id');
  }
  const live = !options['dry-run'];
  const github = client ?? createGitHubClient({ token: env.GITHUB_TOKEN ?? env.GH_TOKEN, log });
  const run = await github.request('GET', `repos/${repo}/actions/runs/${runId}`);
  if (run.head_branch !== CANARY_BRANCH || !['push', 'workflow_dispatch'].includes(run.event)) {
    log(`Run ${runId} is a ${run.event} run on ${run.head_branch}: the alert follows ${CANARY_BRANCH} pushes and dispatches only.`);
    return { action: 'none' };
  }
  const attempt = Number(options.attempt ?? (live ? env.GITHUB_RUN_ATTEMPT : undefined) ?? run.run_attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`invalid run attempt: ${attempt}`);
  if (!live) {
    // The live job runs only while its run is not cancelled (`!cancelled()`).
    // A past run that concluded cancelled may have been cancelled by a newer
    // run or have had a job time out; a dry run cannot tell which, so it does
    // nothing for either, as the live job does for the first.
    const ran = attempt === run.run_attempt ? run : await github.request('GET', `repos/${repo}/actions/runs/${runId}/attempts/${attempt}`);
    if (ran.conclusion === 'cancelled') {
      log(`Run ${runId} attempt ${attempt} was cancelled: a dry run of a cancelled run does nothing.`);
      return { action: 'none', reason: 'the run was cancelled' };
    }
  }
  const profile = runProfile({ option: options.profile, env, live, run });
  const jobs = (await listRunJobs(github, { repo, runId, attempt, log })).filter((job) => job.name !== CANARY_ALERT_JOB);
  const gate = jobs.find((job) => job.name === CI_GATE_JOB);
  // A dry run reads the gate from the past run, never from this shell.
  const gateResult = options['gate-result'] ?? (live ? env.CI_GATE_RESULT : undefined) ?? gate?.conclusion ?? '';
  const issue = await findOpenIssue(github, repo, { label: ALERT_LABEL.name, marker: alertIssue(profile).marker });
  // Only a red run about to open an alert needs the profile's last recovery.
  const recovery = !issue && isRed(gateResult) ? await findLastRecovery(github, repo, profile, log) : undefined;
  const plan = planAlert({
    issue,
    recovery,
    run: runReference(run, {
      attempt,
      profile,
      finishedAt: gate?.completed_at ?? new Date().toISOString(),
      serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
      repo,
    }),
    gateResult,
    jobs,
  });
  log(`Run ${runId} attempt ${attempt} (${run.event}, ${profile}): ${plan.reason}.`);
  if (!live) {
    for (const [label, text] of [['Title', plan.title], ['Body', plan.body], ['Comment', plan.comment]]) {
      if (text) log(`--- ${label} (${plan.action}${plan.issue ? ` #${plan.issue.number}` : ''}) ---\n${text}`);
    }
    return plan;
  }
  const done = await applyAlertPlan(github, repo, plan);
  log(`Alert: ${done}.`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `testnet-canary ${profile} alert: ${done} (${plan.reason}).\n`);
  return plan;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    await runCanaryAlert();
  } catch (error) {
    console.error(`canary-alert: ${error.message}`);
    process.exitCode = 1;
  }
}
