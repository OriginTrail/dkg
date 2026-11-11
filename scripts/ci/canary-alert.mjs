#!/usr/bin/env node
// Opens, comments on or closes the `ci-alert` issue for a finished ci.yml run
// on testnet-canary (scripts/lib/canary-alert.mjs decides which). The
// canary-alert job in .github/workflows/ci.yml runs it after the CI gate of
// every push and dispatched run there, the nightly included, with the gate's
// result in CI_GATE_RESULT and the resolved profile in CI_PROFILE.
//
// --dry-run prints the decision and the issue text for any run without writing
// to GitHub, reading the gate result and profile from the run itself:
//   GITHUB_TOKEN=$(gh auth token) node scripts/ci/canary-alert.mjs --dry-run --repo OriginTrail/dkg --run-id <id>
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ALERT_LABEL, ALERT_MARKER, planAlert } from '../lib/canary-alert.mjs';
import { CANARY_ALERT_JOB, CANARY_BRANCH, CI_GATE_JOB } from '../lib/ci-health.mjs';
import { createGitHubClient, ensureLabel, findOpenIssue, listRunJobs } from '../lib/github-rest.mjs';

const NIGHTLY_ACTOR = 'github-actions[bot]';
const RED = new Set(['failure', 'cancelled', 'timed_out']);

// The newer run of this run's concurrency group that was created before this
// run's gate finished, and so cancelled it (ci.yml cancels in progress): its
// red gate is churn, not a verdict. The job's `!cancelled()` condition already
// skips such runs; this also covers a past one in a dry run. A standard run
// shares its group with pushes and manual dispatches, a nightly with nightlies.
export async function findSupersedingRun(client, { repo, run, profile, gateCompletedAt }) {
  const workflow = path.posix.basename(run.path ?? '.github/workflows/ci.yml');
  const { items } = await client.paginate(`repos/${repo}/actions/workflows/${workflow}/runs`, {
    query: { branch: CANARY_BRANCH, created: `>=${run.created_at}` },
    itemsKey: 'workflow_runs',
  });
  const nightly = (other) => other.event === 'workflow_dispatch' && other.actor?.login === NIGHTLY_ACTOR;
  return items.find((other) => other.id !== run.id
    && Date.parse(other.created_at) > Date.parse(run.created_at)
    && Date.parse(other.created_at) < gateCompletedAt
    && (profile === 'nightly-equivalent' ? nightly(other) : other.event === 'push' || (other.event === 'workflow_dispatch' && !nightly(other))));
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
    case 'update':
      await client.request('PATCH', `repos/${repo}/issues/${plan.issue.number}`, { body: { body: plan.body } });
      await client.request('POST', `repos/${repo}/issues/${plan.issue.number}/comments`, { body: { body: plan.comment } });
      return `${plan.action === 'comment' ? 'commented on' : 'updated'} #${plan.issue.number}`;
    case 'close':
      await client.request('POST', `repos/${repo}/issues/${plan.issue.number}/comments`, { body: { body: plan.comment } });
      await client.request('PATCH', `repos/${repo}/issues/${plan.issue.number}`, { body: { state: 'closed', state_reason: 'completed' } });
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
  // A dry run reads a past run: its gate result and profile come from the run
  // itself, never from this shell's environment.
  const live = !options['dry-run'];
  const github = client ?? createGitHubClient({ token: env.GITHUB_TOKEN ?? env.GH_TOKEN, log });
  const run = await github.request('GET', `repos/${repo}/actions/runs/${runId}`);
  if (run.head_branch !== CANARY_BRANCH || !['push', 'workflow_dispatch'].includes(run.event)) {
    log(`Run ${runId} is a ${run.event} run on ${run.head_branch}: the alert follows ${CANARY_BRANCH} pushes and dispatches only.`);
    return { action: 'none' };
  }
  const attempt = Number(options.attempt ?? (live ? env.GITHUB_RUN_ATTEMPT : undefined) ?? run.run_attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`invalid run attempt: ${attempt}`);
  const jobs = (await listRunJobs(github, { repo, runId, attempt, log })).filter((job) => job.name !== CANARY_ALERT_JOB);
  const gate = jobs.find((job) => job.name === CI_GATE_JOB);
  const gateResult = options['gate-result'] ?? (live ? env.CI_GATE_RESULT : undefined) ?? gate?.conclusion ?? '';
  const inferred = run.event === 'workflow_dispatch' && run.actor?.login === NIGHTLY_ACTOR ? 'nightly-equivalent' : 'standard';
  const profile = options.profile ?? ((live && env.CI_PROFILE) || inferred);
  if (RED.has(gateResult)) {
    const gateCompletedAt = Date.parse(gate?.completed_at ?? '') || Date.now();
    const newer = await findSupersedingRun(github, { repo, run, profile, gateCompletedAt });
    if (newer) {
      log(`Run ${runId} was superseded by run ${newer.id} (${newer.html_url}) before its gate finished: the newer run decides.`);
      return { action: 'none', superseded: newer.id };
    }
  }
  const issue = await findOpenIssue(github, repo, { label: ALERT_LABEL.name, marker: ALERT_MARKER });
  const plan = planAlert({
    issue,
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
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `testnet-canary alert: ${done} (${plan.reason}).\n`);
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
