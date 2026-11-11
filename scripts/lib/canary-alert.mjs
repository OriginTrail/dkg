// The red-canary alert's decisions; scripts/ci/canary-alert.mjs reads the run
// and applies them. Each execution profile has its own `ci-alert` issue, open
// while that profile's CI gate is red on testnet-canary, and only runs of that
// profile write it. Runs of one profile share a ci.yml concurrency group, which
// GitHub runs one at a time, so no two alert jobs ever write one issue at once,
// and no job-level lock is needed (one would cancel pending jobs). A pass closes
// its own profile's issue only: a green push says nothing about a red nightly,
// nor a green nightly about a red push. Pure, so the tests drive every
// transition.
import { CANARY_ALERT_JOB, failuresByLane, inline, rootFailures } from './ci-health.mjs';

export const ALERT_LABEL = Object.freeze({
  name: 'ci-alert',
  color: 'b60205',
  description: 'testnet-canary CI is red; opened and closed by the CI workflow',
});
// The profiles ci.yml resolves (resolve-ci-profile.mjs), each with its issue.
export const PROFILES = Object.freeze(['standard', 'nightly-equivalent']);
export const ALERT_ISSUES = Object.freeze({
  standard: Object.freeze({
    title: 'testnet-canary CI is red',
    marker: '<!-- ci-alert-state:standard ',
    runs: 'pushes and manual standard dispatches',
  }),
  'nightly-equivalent': Object.freeze({
    title: 'testnet-canary nightly is red',
    marker: '<!-- ci-alert-state:nightly-equivalent ',
    runs: 'the nightly and manual nightly-equivalent dispatches',
  }),
});
// A red CI gate; a skipped or missing one says nothing.
const RED = new Set(['failure', 'cancelled', 'timed_out']);
export const isRed = (gateResult) => RED.has(gateResult);
const STEP_FAILED = new Set(['failure', 'timed_out', 'cancelled']);
const DETAILS = '### Latest failure';
const FOOTER = '_Opened, commented on and closed by';

const time = (value) => Date.parse(value);
const stamp = (value) => `${String(value).slice(0, 16).replace('T', ' ')} UTC`;
const runLink = (run) => `[CI #${run.id}${run.attempt > 1 ? `, attempt ${run.attempt}` : ''}](${run.url})`;
const commitLink = (run) => `[\`${String(run.sha).slice(0, 10)}\`](${run.commitUrl})`;

// A profile's issue: its title, state marker and the runs that write it. An
// unknown profile throws rather than file a run under the wrong issue.
export function alertIssue(profile) {
  if (!Object.hasOwn(ALERT_ISSUES, profile)) throw new Error(`unknown CI profile: ${profile}`);
  return ALERT_ISSUES[profile];
}

// The failure details an earlier body showed, kept when a late failure of an
// older commit changes only the state.
function keptDetails(body) {
  const text = String(body ?? '');
  const start = text.indexOf(DETAILS);
  if (start === -1) return '';
  const end = text.indexOf(`\n${FOOTER}`, start);
  return text.slice(start, end === -1 ? undefined : end).trimEnd();
}

// The versioned state in a profile's alert issue body, or undefined: the red
// episode's start (`since`) and latest red `run`; `after`, the pass that
// closed the profile's previous issue, when there was one; and, once closed,
// `recovered`, the pass that closed this one. Each run record is { id,
// attempt, createdAt, url, sha, commitUrl }.
function parseState(body, profile) {
  const { marker } = alertIssue(profile);
  const text = String(body ?? '');
  const start = text.indexOf(marker);
  if (start === -1) return undefined;
  const end = text.indexOf(' -->', start);
  let state;
  try {
    state = JSON.parse(text.slice(start + marker.length, end === -1 ? undefined : end));
  } catch {
    return undefined;
  }
  return state?.version === 1 && state.profile === profile ? state : undefined;
}
const dated = (record) => Number.isFinite(time(record?.createdAt));

// An open alert's state, or undefined when there is none to read (a hand edit
// included). An unreadable `after` is dropped, and an open alert has no
// recovery.
export function readAlertState(body, profile) {
  const state = parseState(body, profile);
  if (!Number.isFinite(time(state?.since)) || !dated(state.run)) return undefined;
  return { version: 1, profile, since: state.since, run: state.run, ...(dated(state.after) ? { after: state.after } : {}) };
}

// The pass that closed a profile's alert issue, as its state records it, or
// undefined (an issue closed by hand, or a state that cannot be read).
export function readRecovery(body, profile) {
  const state = parseState(body, profile);
  return dated(state?.recovered) ? state.recovered : undefined;
}

// `>` is escaped so no value can close the comment early.
const stateMarker = (state) => `${alertIssue(state.profile).marker}${JSON.stringify(state).replace(/>/g, '\\u003e')} -->`;

// The body with its state marker replaced, or added as the first line, and its
// text untouched: closing records the recovery without rewriting the alert.
function withState(body, state) {
  const text = String(body ?? '');
  const start = text.indexOf(alertIssue(state.profile).marker);
  const end = start === -1 ? -1 : text.indexOf(' -->', start);
  if (end === -1) return `${stateMarker(state)}\n${text}`;
  return `${text.slice(0, start)}${stateMarker(state)}${text.slice(end + ' -->'.length)}`;
}

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
  const { title, runs } = alertIssue(state.profile);
  const other = PROFILES.find((profile) => profile !== state.profile);
  return [
    stateMarker(state),
    `**${title}** for the ${state.profile} profile (${runs}). This issue closes itself when a later ${state.profile} run passes; the ${other} profile has its own issue.`,
    '',
    `- **Red since:** ${stamp(state.since)}`,
    `- **Latest red run:** ${runLink(state.run)} at ${commitLink(state.run)}`,
    '',
    details,
    '',
    `${FOOTER} the \`${CANARY_ALERT_JOB}\` job in .github/workflows/ci.yml (scripts/ci/canary-alert.mjs). Keep the first line of this description: it holds the alert's state._`,
  ].join('\n');
}

// What to do with a profile's alert issues for one finished testnet-canary run
// of that profile: `open` (with title, labels and body), `comment` (and
// rewrite the body), `close` (with a comment, and the body recording the
// recovery), `recover` (rewrite a closed alert's body to record a newer
// recovery) or `none`, with the reason.
// - run: { id, attempt, profile, createdAt, finishedAt, url, sha, commitUrl,
//   event, actor, triggeringActor, title }
// - gateResult: the CI gate job's result in this run
// - jobs: this attempt's jobs, from the jobs API
// - issue: the open alert issue of run.profile ({ number, body }), or null
// - closed: with no open issue, the profile's last closed alert ({ issue,
//   recovery }, the recovery when its state records one), if one was found
// Runs are ordered by creation: a re-run keeps its run's commit and creation
// time, so a failing re-run of an old commit is as old as that commit's run.
export function planAlert({ issue, run, gateResult, jobs, closed }) {
  const { title } = alertIssue(run.profile);
  const state = issue ? readAlertState(issue.body, run.profile) : undefined;
  if (gateResult === 'success') {
    // With no alert open, a pass still moves the profile's recovery forward
    // on its last closed alert, so that a failure of an older run cannot open
    // one later. With none closed yet there is no recovery to keep.
    if (!issue) {
      if (!closed?.issue) return { action: 'none', reason: `CI gate passed; no ${run.profile} alert is open or closed` };
      if (closed.recovery && time(closed.recovery.createdAt) >= time(run.createdAt)) {
        return { action: 'none', reason: `CI gate passed; closed #${closed.issue.number} already records a recovery no older (#${closed.recovery.id})` };
      }
      const advanced = { ...(parseState(closed.issue.body, run.profile) ?? { version: 1, profile: run.profile }), recovered: recorded(run) };
      return {
        action: 'recover',
        issue: closed.issue,
        state: advanced,
        body: withState(closed.issue.body, advanced),
        reason: `CI gate passed; recording it as the ${run.profile} recovery on closed #${closed.issue.number}`,
      };
    }
    // An older commit passing late proves nothing about a newer red one. An
    // issue whose state is unreadable closes on any pass of its profile.
    if (state && time(state.run.createdAt) > time(run.createdAt)) {
      return { action: 'none', reason: `CI gate passed, but #${issue.number} records a newer red run (#${state.run.id})` };
    }
    // The closed issue keeps this pass as the profile's latest recovery, so a
    // later failure of an older run cannot reopen the alert.
    const recovered = { ...(state ?? { version: 1, profile: run.profile }), recovered: recorded(run) };
    return {
      action: 'close',
      issue,
      state: recovered,
      body: withState(issue.body, recovered),
      comment: `**Green again:** ${runLink(run)} (\`${run.event}\`, ${run.profile} profile) passed at ${commitLink(run)}. Closing.`,
      reason: `CI gate passed; closing #${issue.number}`,
    };
  }
  if (!RED.has(gateResult)) return { action: 'none', reason: `CI gate result is ${gateResult || 'missing'}` };
  // The pass this red episode follows: the recovery found for a new alert, or
  // the one an open alert recorded when it opened. A run no newer than that
  // pass, such as a failing re-run of an older commit, proves nothing now.
  const after = issue ? state?.after : closed?.recovery;
  if (dated(after) && time(run.createdAt) <= time(after.createdAt)) {
    return {
      action: 'none',
      reason: `CI gate ${gateResult}, but a newer run (#${after.id}) has passed since this one was created; ${issue ? `leaving #${issue.number} as it is` : `not reopening the ${run.profile} alert`}`,
    };
  }
  const newer = !state || time(run.createdAt) >= time(state.run.createdAt);
  const next = {
    version: 1,
    profile: run.profile,
    since: state && time(state.since) <= time(run.createdAt) ? state.since : run.createdAt,
    run: newer ? recorded(run) : state.run,
    ...(dated(after) ? { after } : {}),
  };
  const failure = renderFailure(run, jobs);
  if (!issue) {
    return {
      action: 'open',
      title,
      labels: [ALERT_LABEL.name],
      state: next,
      body: renderAlertBody(next, `${DETAILS}\n\n${failure}`),
      reason: `CI gate ${gateResult}; opening the ${run.profile} alert`,
    };
  }
  return {
    action: 'comment',
    issue,
    state: next,
    body: renderAlertBody(next, newer ? `${DETAILS}\n\n${failure}` : keptDetails(issue.body)),
    comment: `### Still red: ${runLink(run)}\n\n${failure}`,
    reason: `CI gate ${gateResult}; commenting on #${issue.number}`,
  };
}
