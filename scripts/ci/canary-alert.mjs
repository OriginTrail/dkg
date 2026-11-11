#!/usr/bin/env node
// Opens, comments on or closes the `ci-alert` issue of a finished ci.yml run's
// profile on testnet-canary, or records a newer pass on its last closed one
// (scripts/lib/canary-alert.mjs decides which). The
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
import { ALERT_LABEL, alertIssue, compareRuns, isRed, planAlert, PROFILES, readRecovery } from '../lib/canary-alert.mjs';
import { CANARY_ALERT_JOB, CANARY_BRANCH, CI_GATE_JOB, runProfile } from '../lib/ci-health.mjs';
import { createGitHubClient, ensureLabel, findOpenIssue, listRunJobs } from '../lib/github-rest.mjs';

// The alert's time budget. A job that reaches its timeout is cancelled, and a
// cancelled job turns the whole run cancelled, a green nightly included, so
// the alert gives up long before ci.yml's timeout for its job: it waits at
// most a minute for a rate limit and stops everything after three minutes.
// It then fails, and the job's continue-on-error keeps that out of the run.
export const ALERT_LIMITS = Object.freeze({ maxWaitMs: 60 * 1000, deadlineMs: 3 * 60 * 1000 });

// The GitHub client the alert uses, within ALERT_LIMITS.
export function alertClient(env, options = {}) {
  return createGitHubClient({ token: env.GITHUB_TOKEN ?? env.GH_TOKEN, ...ALERT_LIMITS, ...options });
}

// The profile the run executed, whose issue it writes. The live job passes the
// one ci.yml resolved (CI_PROFILE), and --profile overrides it. Only a dry run
// of a past run without either reads it from the run, as the weekly report
// does (runProfile in ci-health.mjs), so the live job never relies on that.
export function alertProfile({ option, env, live, run }) {
  const recorded = live ? undefined : runProfile(run);
  const profile = option ?? (env.CI_PROFILE || undefined) ?? recorded;
  if (!PROFILES.includes(profile)) throw new Error(`needs --profile or CI_PROFILE set to ${PROFILES.join(' or ')}, not ${profile ?? 'nothing'}`);
  return profile;
}

// The profile's last closed alert, as { issue, recovery }: the one recording
// the newest recovery, or else its most recently updated one (closed by hand,
// say, with no recovery), from the closed alerts GitHub updated last, in one
// request: it cannot sort by closing time, but closing or recording a
// recovery updates an issue. Undefined when the profile has no closed alert,
// and when the lookup fails: a red run then opens and a pass records nothing,
// as they would with no recovery on record.
export async function findLastClosedAlert(client, repo, profile, log = () => {}) {
  try {
    const issues = await client.request('GET', `repos/${repo}/issues`, {
      query: { labels: ALERT_LABEL.name, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 },
    });
    const own = issues.filter((issue) => !issue.pull_request && String(issue.body ?? '').includes(alertIssue(profile).marker));
    const recovered = own
      .map((issue) => ({ issue, recovery: readRecovery(issue.body, profile) }))
      .filter(({ recovery }) => recovery)
      .sort((a, b) => compareRuns(b.recovery, a.recovery));
    return recovered[0] ?? (own[0] && { issue: own[0], recovery: undefined });
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
    case 'recover':
      // Recording a newer recovery only sharpens a later decision: if it
      // fails, the run's outcome stands and the job does not fail.
      try {
        await client.request('PATCH', `repos/${repo}/issues/${plan.issue.number}`, { body: { body: plan.body } });
        return `recorded the recovery on closed #${plan.issue.number}`;
      } catch (error) {
        return `could not record the recovery on closed #${plan.issue.number} (${error.message})`;
      }
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
  const github = client ?? alertClient(env, { log });
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
  const profile = alertProfile({ option: options.profile, env, live, run });
  const jobs = (await listRunJobs(github, { repo, runId, attempt, log })).filter((job) => job.name !== CANARY_ALERT_JOB);
  const gate = jobs.find((job) => job.name === CI_GATE_JOB);
  // A dry run reads the gate from the past run, never from this shell.
  const gateResult = options['gate-result'] ?? (live ? env.CI_GATE_RESULT : undefined) ?? gate?.conclusion ?? '';
  const issue = await findOpenIssue(github, repo, { label: ALERT_LABEL.name, marker: alertIssue(profile).marker });
  // With no open alert, a red run about to open one checks the profile's last
  // recovery, and a pass moves it forward: both read the last closed alert.
  const closed = !issue && (gateResult === 'success' || isRed(gateResult)) ? await findLastClosedAlert(github, repo, profile, log) : undefined;
  const plan = planAlert({
    issue,
    closed,
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
