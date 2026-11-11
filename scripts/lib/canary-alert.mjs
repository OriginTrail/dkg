// The red-canary alert's decisions; scripts/ci/canary-alert.mjs reads the run
// and applies them. One open `ci-alert` issue stands for testnet-canary CI
// being red. Its body carries a hidden state marker that records which
// execution profile is red, because a passing push run (the standard profile)
// does not prove a red nightly (the nightly-equivalent profile) green. Pure, so
// the tests drive every transition.
import { CANARY_ALERT_JOB, failuresByLane, inline, rootFailures } from './ci-health.mjs';

export const ALERT_LABEL = Object.freeze({
  name: 'ci-alert',
  color: 'b60205',
  description: 'testnet-canary CI is red; opened and closed by the CI workflow',
});
export const ALERT_TITLE = 'testnet-canary CI is red';
export const ALERT_MARKER = '<!-- ci-alert-state ';
export const PROFILES = Object.freeze(['standard', 'nightly-equivalent']);
// What a passing run of each profile proves green: the nightly-equivalent
// profile runs every lane the standard one does, and more.
const CLEARS = Object.freeze({ standard: ['standard'], 'nightly-equivalent': ['standard', 'nightly-equivalent'] });
// A red CI gate; a skipped or missing one says nothing.
const RED = new Set(['failure', 'cancelled', 'timed_out']);
const STEP_FAILED = new Set(['failure', 'timed_out', 'cancelled']);
const DETAILS = '### Latest failure';
const FOOTER = '_Opened, commented on and closed by';

const time = (value) => Date.parse(value);

// The failure details an earlier body showed, kept when a run changes only
// the state (a partial pass, or a late failure of an older commit).
function keptDetails(body) {
  const text = String(body ?? '');
  const start = text.indexOf(DETAILS);
  if (start === -1) return '';
  const end = text.indexOf(`\n${FOOTER}`, start);
  return text.slice(start, end === -1 ? undefined : end).trimEnd();
}
const stamp = (value) => `${String(value).slice(0, 16).replace('T', ' ')} UTC`;
const runLink = (run) => `[CI #${run.id}${run.attempt > 1 ? `, attempt ${run.attempt}` : ''}](${run.url})`;
const commitLink = (run) => `[\`${String(run.sha).slice(0, 10)}\`](${run.commitUrl})`;

// The state in an alert issue's body: { version: 1, failing: { <profile>:
// { since, run } } }, or undefined when there is none to read. A profile
// entry without readable times (a hand edit) is dropped.
export function readAlertState(body) {
  const text = String(body ?? '');
  const start = text.indexOf(ALERT_MARKER);
  if (start === -1) return undefined;
  const end = text.indexOf(' -->', start);
  let state;
  try {
    state = JSON.parse(text.slice(start + ALERT_MARKER.length, end === -1 ? undefined : end));
  } catch {
    return undefined;
  }
  if (state?.version !== 1 || !state.failing || typeof state.failing !== 'object') return undefined;
  const readable = (entry) => Number.isFinite(time(entry?.since)) && Number.isFinite(time(entry?.run?.createdAt));
  return { version: 1, failing: Object.fromEntries(PROFILES.filter((profile) => readable(state.failing[profile])).map((profile) => [profile, state.failing[profile]])) };
}

// `>` is escaped so no value can close the comment early.
const stateMarker = (state) => `${ALERT_MARKER}${JSON.stringify(state).replace(/>/g, '\\u003e')} -->`;

// The run as the issue records it.
const recorded = ({ id, attempt, createdAt, url, sha, commitUrl }) => ({ id, attempt, createdAt, url, sha, commitUrl });

function failedJobs(jobs) {
  return jobs
    .filter((job) => job.status === 'completed' && STEP_FAILED.has(job.conclusion) && job.name !== CANARY_ALERT_JOB)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      steps: (job.steps ?? []).filter((step) => STEP_FAILED.has(step.conclusion)).sort((a, b) => a.number - b.number).map((step) => step.name),
    }));
}

export function renderFailure(run, jobs) {
  const lanes = failuresByLane(rootFailures(jobs));
  const actor = run.triggeringActor && run.triggeringActor !== run.actor
    ? `\`${inline(run.actor)}\` (triggered by \`${inline(run.triggeringActor)}\`)`
    : `\`${inline(run.actor)}\``;
  const lines = [
    `- **Run:** ${runLink(run)}, \`${run.event}\`, ${run.profile} profile, finished ${stamp(run.finishedAt ?? run.createdAt)}`,
    `- **Commit:** ${commitLink(run)} ${inline(run.title, 100)}`,
    `- **Actor:** ${actor}`,
    '- **Failed jobs:**',
  ];
  if (lanes.length === 0) lines.push('  - No failed job in the jobs API; see the run.');
  for (const lane of lanes) {
    const shards = lane.jobs.length > 1 ? `, ${lane.jobs.length} jobs` : '';
    const how = lane.cancelled ? ', cancelled (a timeout or a manual cancel)' : '';
    const steps = lane.steps.length ? `, failed step${lane.steps.length > 1 ? 's' : ''}: ${lane.steps.map((step) => `\`${inline(step, 80)}\``).join(', ')}` : '';
    lines.push(`  - **${inline(lane.lane)}**${shards}${how}${steps}`);
  }
  const every = failedJobs(jobs);
  if (every.length) {
    lines.push('', '<details><summary>Every failed job and step</summary>', '');
    for (const job of every) {
      lines.push(`- ${inline(job.name)} (${job.conclusion})${job.steps.length ? `: ${job.steps.map((step) => inline(step, 80)).join('; ')}` : ''}`);
    }
    lines.push('', '</details>');
  }
  return lines.join('\n');
}

export function renderAlertBody(state, details) {
  const rows = PROFILES.filter((profile) => state.failing[profile]).map((profile) => {
    const { since, run } = state.failing[profile];
    return `| ${profile} | ${stamp(since)} | ${runLink(run)} | ${commitLink(run)} |`;
  });
  return [
    stateMarker(state),
    `**testnet-canary CI is red.** This issue closes itself when a later run passes: a \`standard\` pass (a push, or a manual dispatch) clears the standard profile, and a \`nightly-equivalent\` pass (the nightly) clears both.`,
    '',
    '| Profile | Red since | Latest red run | Commit |',
    '|---|---|---|---|',
    ...rows,
    '',
    details,
    '',
    `${FOOTER} the \`${CANARY_ALERT_JOB}\` job in .github/workflows/ci.yml (scripts/ci/canary-alert.mjs). Keep the first line of this description: it holds the alert's state._`,
  ].join('\n');
}

// What to do with the alert issue for one finished run of testnet-canary CI:
// `open` (with title, labels and body), `comment` (and rewrite the body),
// `update` (a pass cleared some profiles, others stay red), `close` (with a
// comment) or `none`, with the reason.
// - run: { id, attempt, profile, createdAt, finishedAt, url, sha, commitUrl,
//   event, actor, triggeringActor, title }
// - gateResult: the CI gate job's result in this run
// - jobs: this attempt's jobs, from the jobs API
// - issue: the open alert issue ({ number, body }), or null
export function planAlert({ issue, run, gateResult, jobs }) {
  const profile = PROFILES.includes(run.profile) ? run.profile : 'standard';
  const current = { ...run, profile };
  const state = issue ? readAlertState(issue.body) : undefined;
  if (gateResult === 'success') {
    if (!issue) return { action: 'none', reason: `CI gate passed and no ${ALERT_LABEL.name} issue is open` };
    const failing = { ...state?.failing };
    // A pass clears a red profile it covers, from a run no newer than itself:
    // an older commit passing late proves nothing about a newer red one.
    const cleared = CLEARS[profile].filter((name) => failing[name] && time(failing[name].run.createdAt) <= time(run.createdAt));
    if (Object.keys(failing).length > 0 && cleared.length === 0) {
      return { action: 'none', reason: `CI gate passed, but ${Object.keys(failing).join(' and ')} stays red until a run covering it passes` };
    }
    for (const name of cleared) delete failing[name];
    const remaining = PROFILES.filter((name) => failing[name]);
    const passed = `**Green again:** ${runLink(current)} (\`${run.event}\`, ${profile} profile) passed at ${commitLink(current)}.`;
    if (!state || remaining.length === 0) {
      return { action: 'close', issue, comment: `${passed} Closing.`, reason: `CI gate passed; closing #${issue.number}` };
    }
    const next = { version: 1, failing };
    const still = remaining.map((name) => `${name} (red since ${stamp(failing[name].since)}, latest ${runLink(failing[name].run)})`).join(' and ');
    return {
      action: 'update',
      issue,
      state: next,
      body: renderAlertBody(next, keptDetails(issue.body)),
      comment: `${passed} That clears ${cleared.join(' and ')}; ${still} is still red, so this stays open until a run covering it passes.`,
      reason: `CI gate passed; ${cleared.join(' and ')} cleared, ${remaining.join(' and ')} still red`,
    };
  }
  if (!RED.has(gateResult)) return { action: 'none', reason: `CI gate result is ${gateResult || 'missing'}` };
  const failing = { ...state?.failing };
  const previous = failing[profile];
  const newer = !previous || time(run.createdAt) >= time(previous.run.createdAt);
  failing[profile] = {
    since: previous && time(previous.since) <= time(run.createdAt) ? previous.since : run.createdAt,
    run: newer ? recorded(current) : previous.run,
  };
  const next = { version: 1, failing };
  const failure = renderFailure(current, jobs);
  const body = renderAlertBody(next, `${DETAILS}\n\n${failure}`);
  if (!issue) return { action: 'open', title: ALERT_TITLE, labels: [ALERT_LABEL.name], state: next, body, reason: `CI gate ${gateResult}; opening the alert` };
  return {
    action: 'comment',
    issue,
    state: next,
    body: newer ? body : renderAlertBody(next, keptDetails(issue.body)),
    comment: `### Still red: ${runLink(current)}\n\n${failure}`,
    reason: `CI gate ${gateResult}; commenting on #${issue.number}`,
  };
}
