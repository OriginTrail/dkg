#!/usr/bin/env node
// The weekly CI health report (.github/workflows/ci-health-report.yml runs it;
// scripts/lib/ci-health.mjs does the arithmetic). It reads the last --days of
// ci.yml runs and their jobs, every attempt, from the Actions API, plus the
// nightly dispatcher's runs and the test exceptions in this checkout, then
// prints markdown, appends it to --summary, and with --publish-issue rewrites
// the `ci-health` issue and comments its headline. Without --publish-issue it
// writes nothing to GitHub, so a local dry run is:
//   GITHUB_TOKEN=$(gh auth token) node scripts/ci/ci-health-report.mjs --repo OriginTrail/dkg
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildHealthReport,
  classifyRuns,
  isTestExceptionFile,
  parseTestExceptions,
  renderHealthHeadline,
  renderHealthReport,
} from '../lib/ci-health.mjs';
import { createGitHubClient, ensureLabel, findOpenIssue, GitHubRequestError, listRunJobs, listWorkflowRuns } from '../lib/github-rest.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAY = 86_400_000;
export const HEALTH_LABEL = Object.freeze({
  name: 'ci-health',
  color: '0e8a16',
  description: 'Weekly CI health report; rewritten by the CI health report workflow',
});
export const HEALTH_MARKER = '<!-- ci-health-report -->';
export const HEALTH_TITLE = 'Weekly CI health report';
// GitHub refuses an issue body over 65,536 characters.
const ISSUE_BODY_LIMIT = 65_000;

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// The runs whose jobs the report reads: in this window every finished verdict
// and unexplained cancellation (a superseded run's jobs are cancellations, not
// verdicts); in the prior one only the green first-attempt PR runs, for the
// time-to-green comparison.
export function runsNeedingJobs(classified, { window, previousWindow }) {
  const inside = (run, { start, end }) => Date.parse(run.created_at) >= start && Date.parse(run.created_at) < end;
  return classified.filter(({ run, kind, outcome }) => (inside(run, window) && ['success', 'failure', 'cancelled'].includes(outcome))
    || (inside(run, previousWindow) && kind === 'pr' && outcome === 'success' && run.run_attempt === 1))
    .map(({ run }) => run);
}

// The `test-disable-allow:` exceptions in tracked test files.
export function trackedTestExceptions(root = REPO_ROOT) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((file) => file && isTestExceptionFile(file));
  return files.flatMap((file) => {
    let source;
    try {
      source = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      return [];
    }
    return source.includes('test-disable-allow:') ? parseTestExceptions(source).map((exception) => ({ file, ...exception })) : [];
  });
}

export function issueBody(markdown, runUrl) {
  const note = `\n_Truncated to fit an issue; the full report is in the ${runUrl ? `[workflow run](${runUrl})` : 'workflow run'} summary._\n`;
  let text = `${HEALTH_MARKER}\n${markdown}`;
  if (text.length > ISSUE_BODY_LIMIT) text = `${text.slice(0, text.lastIndexOf('\n', ISSUE_BODY_LIMIT - note.length))}\n${note}`;
  return text;
}

// One open `ci-health` issue carries the latest report; each week rewrites
// it and comments the headline, so subscribers are notified and the comments
// keep the trend.
export async function publishHealthIssue(client, repo, { markdown, headline, runUrl }) {
  await ensureLabel(client, repo, HEALTH_LABEL);
  const body = issueBody(markdown, runUrl);
  const issue = await findOpenIssue(client, repo, { label: HEALTH_LABEL.name, marker: HEALTH_MARKER });
  if (!issue) {
    const created = await client.request('POST', `repos/${repo}/issues`, { body: { title: HEALTH_TITLE, body, labels: [HEALTH_LABEL.name] } });
    return `opened #${created.number}`;
  }
  await client.request('PATCH', `repos/${repo}/issues/${issue.number}`, { body: { body } });
  await client.request('POST', `repos/${repo}/issues/${issue.number}/comments`, {
    body: { body: `${headline}${runUrl ? `\n\n[Workflow run](${runUrl})` : ''}` },
  });
  return `updated #${issue.number}`;
}

function positiveInteger(value, name, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`--${name} must be an integer from 1 to ${max}`);
  return number;
}

export async function runHealthReport({
  argv = process.argv.slice(2),
  env = process.env,
  client,
  now = Date.now(),
  root = REPO_ROOT,
  log = (message) => console.error(message),
  print = (text) => process.stdout.write(text),
} = {}) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      days: { type: 'string', default: '7' },
      end: { type: 'string' },
      workflow: { type: 'string', default: 'ci.yml' },
      'nightly-workflow': { type: 'string', default: 'nightly-ci.yml' },
      'exception-days': { type: 'string', default: '14' },
      // GitHub asks clients to keep concurrent requests few.
      concurrency: { type: 'string', default: '4' },
      output: { type: 'string' },
      summary: { type: 'string' },
      'publish-issue': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('needs --repo OWNER/NAME or GITHUB_REPOSITORY');
  const days = positiveInteger(options.days, 'days', 60);
  const exceptionDays = positiveInteger(options['exception-days'], 'exception-days', 60);
  const concurrency = positiveInteger(options.concurrency, 'concurrency', 32);
  const end = options.end === undefined ? now : Date.parse(options.end);
  if (!Number.isFinite(end)) throw new Error(`--end is not a date: ${options.end}`);
  const window = { start: end - days * DAY, end };
  const previousWindow = { start: end - 2 * days * DAY, end: window.start };
  const github = client ?? createGitHubClient({ token: env.GITHUB_TOKEN ?? env.GH_TOKEN, log });

  log(`Reading ${options.workflow} runs created since ${new Date(previousWindow.start).toISOString()}`);
  const runs = await listWorkflowRuns(github, { repo, workflow: options.workflow, since: previousWindow.start, until: end });
  const wanted = runsNeedingJobs(classifyRuns(runs), { window, previousWindow });
  log(`Reading the jobs of ${wanted.length} of ${runs.length} runs`);
  const jobsByRun = new Map();
  let unreadRuns = 0;
  await mapLimit(wanted, concurrency, async (run) => {
    try {
      jobsByRun.set(run.id, await listRunJobs(github, { repo, runId: run.id, log }));
    } catch (error) {
      unreadRuns += 1;
      log(`Could not read the jobs of run ${run.id}: ${error.message}`);
    }
  });
  let dispatcherRuns = [];
  try {
    dispatcherRuns = await listWorkflowRuns(github, { repo, workflow: options['nightly-workflow'], since: window.start, until: end });
  } catch (error) {
    if (!(error instanceof GitHubRequestError && error.status === 404)) throw error;
    log(`${options['nightly-workflow']} is not a workflow here: nightly dispatches are not checked`);
  }
  const model = buildHealthReport({
    repo,
    serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
    window,
    previousWindow,
    runs,
    jobsByRun,
    unreadRuns,
    dispatcherRuns,
    exceptions: trackedTestExceptions(root),
    exceptionDays,
    generatedAt: now,
    requestCount: github.requestCount,
  });
  const markdown = renderHealthReport(model);
  if (options.output) fs.writeFileSync(options.output, markdown);
  if (options.summary) fs.appendFileSync(options.summary, markdown);
  if (!options.output && !options.summary) print(markdown);
  if (options['publish-issue']) {
    const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    log(`CI health issue: ${await publishHealthIssue(github, repo, { markdown, headline: renderHealthHeadline(model), runUrl })}`);
  }
  return { model, markdown };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    await runHealthReport();
  } catch (error) {
    console.error(`ci-health-report: ${error.message}`);
    process.exitCode = 1;
  }
}
