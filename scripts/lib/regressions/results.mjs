import path from 'node:path';
import { phaseInterrupted } from './phases.mjs';

// Report paths were written by the machine that ran the proof, so they are read
// with its path rules, not the validating machine's: a receipt from Windows
// validates on Linux and the reverse.
const pathsFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
function repositoryRelative(root, file, platform) {
  const paths = pathsFor(platform);
  return paths.relative(root, file).split(paths.sep).join('/');
}

export function verifyDiscovery(records, profile, root, platform = process.platform) {
  const matches = records.filter((row) => repositoryRelative(root, row.file, platform) === profile.file
    && row.name === profile.discoveryName);
  if (matches.length !== 1 || records.length !== 1) throw new Error('missing, ambiguous or undiscovered regression assertion');
}

// `platform` is the one that produced the report: the proof's own for a live
// run, the receipt's recorded toolchain platform when validating stored evidence.
export function inspectExecution(report, execution, profile, root, side, platform = process.platform) {
  if (phaseInterrupted(execution)) throw new Error('crash, prerequisite failure, cancellation or generic runner timeout');
  const suites = report?.testResults;
  const assertions = suites?.flatMap((suite) => suite.assertionResults ?? []);
  if (!Array.isArray(suites) || suites.length !== 1 || assertions.length !== 1
      || repositoryRelative(root, suites[0].name, platform) !== profile.file
      || assertions[0].fullName !== profile.fullName) throw new Error('zero selected tests, wrong file or wrong failing assertion');
  const assertion = assertions[0];
  if (report.numTotalTests !== 1 || report.numPendingTests !== 0 || report.numTodoTests !== 0
      || !['passed', 'failed'].includes(assertion.status)) throw new Error('skipped or disabled assertion');
  const markers = execution.stdout.split(/\r?\n/).filter((line) => line.startsWith(`REGRESSION_OBSERVATION ${profile.caseId} `));
  if (markers.length !== 1) throw new Error('missing successful setup/behavior observation');
  const runtimes = execution.stdout.split(/\r?\n/).filter((line) => line.startsWith(`REGRESSION_RUNTIME ${profile.caseId} `));
  if (runtimes.length !== 1 || !runtimes[0].slice(`REGRESSION_RUNTIME ${profile.caseId} `.length).startsWith('v22.')) throw new Error('missing or incompatible actual test runtime');
  const runtime = runtimes[0].slice(`REGRESSION_RUNTIME ${profile.caseId} `.length);
  const observation = JSON.parse(markers[0].slice(`REGRESSION_OBSERVATION ${profile.caseId} `.length));
  if (side === 'bad') {
    if (execution.code !== 1 || assertion.status !== 'failed' || suites[0].status !== 'failed'
        || report.numFailedTests !== 1 || report.numPassedTests !== 0 || report.success !== false
        || assertion.failureMessages.length !== 1
        || !assertion.failureMessages[0].startsWith(`AssertionError: ${profile.assertion}`)
        || !profile.badObservation(observation)) throw new Error('failure is not the intended behavioral assertion');
  } else if (side === 'candidate') {
    if (execution.code !== 0 || assertion.status !== 'passed' || suites[0].status !== 'passed'
        || report.numPassedTests !== 1 || report.numFailedTests !== 0 || report.success !== true
        || assertion.failureMessages.length !== 0) throw new Error('corrected candidate assertion did not pass');
  } else throw new Error('unknown proof side');
  return { file: profile.file, assertion: profile.fullName, status: assertion.status, runtime, observation,
    diagnostic: assertion.failureMessages[0] ?? null };
}
