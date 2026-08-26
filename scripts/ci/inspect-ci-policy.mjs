#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CONTROLLER_POLICY_FILES,
  isProtectedHistoryComparison,
  validateTrustedControllerPins,
} from './trusted-controller-pins.mjs';
import {
  evaluateEffectiveDeltaRolloutRules,
  rulesetIdsRequiringDetails,
  TESTNET_CANARY_ROLLOUT_POLICY,
} from './validate-delta-rollout-ruleset.mjs';

const API_ROOT = 'https://api.github.com';
const API_PAGE_SIZE = 100;
const CHECK_STATUSES = new Set(['pass', 'fail', 'error', 'not-run']);

async function githubRequest(endpoint, token) {
  const response = await fetch(`${API_ROOT}/${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${endpoint} returned ${response.status}`);
  }
  return response.json();
}

async function githubPaginatedArray(endpoint, token, requestJson) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const pageItems = await requestJson(
      `${endpoint}${separator}per_page=${API_PAGE_SIZE}&page=${page}`,
      token,
    );
    if (!Array.isArray(pageItems)) {
      throw new Error(`GitHub API ${endpoint} returned a non-array page`);
    }
    items.push(...pageItems);
    if (pageItems.length < API_PAGE_SIZE) return items;
  }
}

function repositoryFile(filePath) {
  return {
    sourceName: filePath,
    source: fs.readFileSync(filePath, 'utf8'),
  };
}

function checkResult(status, details = null, error = null) {
  if (!CHECK_STATUSES.has(status)) throw new Error(`invalid CI policy check status: ${status}`);
  return {
    status,
    ...(details === null ? {} : { details }),
    ...(error === null ? {} : { error }),
  };
}

function emptySnapshot(policy = TESTNET_CANARY_ROLLOUT_POLICY) {
  return {
    version: 2,
    policy,
    controller: { pin: null },
    checks: {
      provenance: checkResult('not-run'),
      rollout: checkResult('not-run'),
      freshness: checkResult('not-run'),
    },
  };
}

function policyChecksPass(snapshot) {
  return snapshot.checks?.provenance?.status === 'pass'
    && snapshot.checks?.rollout?.status === 'pass';
}

export async function inspectCiPolicyProtections({
  workflows,
  token,
  requestJson = githubRequest,
  policy = TESTNET_CANARY_ROLLOUT_POLICY,
}) {
  const snapshot = emptySnapshot(policy);
  const { repository, branch, controllerBranches, controllerFreshnessBranch } = policy;

  try {
    const controllerModel = validateTrustedControllerPins(workflows, policy);
    snapshot.controller = {
      pin: controllerModel.ref,
      protectedBranches: controllerBranches,
      freshnessBranch: controllerFreshnessBranch,
    };
    const comparisons = await Promise.all(controllerBranches.map(async (protectedBranch) => {
      const compare = await requestJson(
        `repos/${repository}/compare/${encodeURIComponent(controllerModel.ref)}...${encodeURIComponent(protectedBranch)}`,
        token,
      );
      return { branch: protectedBranch, status: compare?.status ?? 'missing' };
    }));
    const protectedHistory = comparisons.find((comparison) => (
      isProtectedHistoryComparison(comparison.status)
    ));
    snapshot.checks.provenance = checkResult(
      protectedHistory ? 'pass' : 'fail',
      { comparisons, protectedHistory: protectedHistory?.branch ?? null },
    );
  } catch (error) {
    snapshot.checks.provenance = checkResult('error', null, error.message);
  }

  try {
    const effectiveRules = await githubPaginatedArray(
      `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`,
      token,
      requestJson,
    );
    const effectiveRulesetIds = rulesetIdsRequiringDetails(effectiveRules);
    const rulesets = await Promise.all(effectiveRulesetIds.map((rulesetId) => (
      requestJson(`repos/${repository}/rulesets/${encodeURIComponent(rulesetId)}`, token)
    )));
    const evaluation = evaluateEffectiveDeltaRolloutRules({
      rules: effectiveRules,
      rulesets,
      policy,
    });
    snapshot.checks.rollout = checkResult(evaluation.ok ? 'pass' : 'fail', evaluation);
  } catch (error) {
    snapshot.checks.rollout = checkResult('error', null, error.message);
  }

  return snapshot;
}

export async function inspectCiPolicyFreshness({
  inspection,
  token,
  requestJson = githubRequest,
}) {
  const snapshot = structuredClone(inspection);
  const { repository } = snapshot.policy ?? {};
  const { pin, freshnessBranch } = snapshot.controller ?? {};
  if (typeof repository !== 'string' || typeof pin !== 'string' || !pin || !freshnessBranch) {
    snapshot.checks.freshness = checkResult(
      'error',
      null,
      'policy inspection did not produce controller metadata',
    );
    return snapshot;
  }

  try {
    const controllerFiles = await Promise.all(CONTROLLER_POLICY_FILES.map(async (filePath) => {
      const endpoint = `repos/${repository}/contents/${filePath}`;
      const [pinned, current] = await Promise.all([
        requestJson(`${endpoint}?ref=${encodeURIComponent(pin)}`, token),
        requestJson(`${endpoint}?ref=${encodeURIComponent(freshnessBranch)}`, token),
      ]);
      if (typeof pinned?.sha !== 'string' || typeof current?.sha !== 'string') {
        throw new Error(`${filePath} contents response is missing a blob SHA`);
      }
      return {
        path: filePath,
        pinnedSha: pinned.sha,
        currentSha: current.sha,
        current: pinned.sha === current.sha,
      };
    }));
    const driftedFiles = controllerFiles
      .filter((file) => !file.current)
      .map((file) => file.path);
    snapshot.checks.freshness = checkResult(
      driftedFiles.length === 0 ? 'pass' : 'fail',
      { branch: freshnessBranch, driftedFiles, files: controllerFiles },
    );
  } catch (error) {
    snapshot.checks.freshness = checkResult('error', null, error.message);
  }
  return snapshot;
}

export function parseCiPolicyArguments(argv) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      workflow: { type: 'string', multiple: true, default: [] },
      output: { type: 'string' },
      summary: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (options.workflow.length === 0) throw new Error('at least one workflow is required');
  const { workflow: workflows, ...singleValueOptions } = options;
  return { ...singleValueOptions, workflows };
}

function writeSnapshot(filePath, snapshot) {
  if (filePath) fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function renderCiPolicyReport(snapshot) {
  const warnings = [];
  const policy = snapshot.policy ?? TESTNET_CANARY_ROLLOUT_POLICY;
  const controller = snapshot.controller ?? {};
  const provenance = snapshot.checks?.provenance ?? checkResult('not-run');
  const freshness = snapshot.checks?.freshness ?? checkResult('not-run');
  const rollout = snapshot.checks?.rollout ?? checkResult('not-run');
  const pinned = typeof controller.pin === 'string' ? controller.pin.slice(0, 12) : '?';
  const protectedBranches = policy.controllerBranches?.join(' or ') ?? 'protected repository history';
  let controllerExpected = `protected ${protectedBranches} history`;
  let controllerStatus = '⚠ unable to inspect';

  if (provenance.status === 'error') {
    warnings.push(`trusted CI controller inspection failed: ${provenance.error}`);
  } else if (provenance.status === 'fail') {
    controllerStatus = '⚠ untrusted provenance';
    warnings.push(`trusted CI controller ${pinned} is not in protected ${protectedBranches} history`);
  } else if (provenance.status === 'pass') {
    if (freshness.status === 'not-run') {
      controllerStatus = '✓ protected';
    } else {
      controllerExpected = `${policy.controllerFreshnessBranch} policy tree`;
      if (freshness.status === 'pass') {
        controllerStatus = '✓ current';
      } else if (freshness.status === 'fail') {
        controllerStatus = '⚠ policy drift';
        warnings.push(`trusted CI controller ${pinned} differs from ${policy.controllerFreshnessBranch}`);
      } else {
        warnings.push(`trusted CI controller freshness inspection failed: ${freshness.error}`);
      }
    }
  } else {
    warnings.push('trusted CI controller inspection did not run');
  }

  let safeguardsPinned = '?';
  let safeguardsStatus = '⚠ unable to inspect';
  if (rollout.status === 'pass') {
    safeguardsPinned = 'active ruleset';
    safeguardsStatus = '✓ current';
  } else if (rollout.status === 'fail') {
    safeguardsStatus = '⚠ safeguards missing';
    warnings.push(`${policy.label} missing: ${rollout.details.missing.join(', ')}`);
  } else if (rollout.status === 'error') {
    warnings.push(`${policy.label} inspection failed: ${rollout.error}`);
  } else {
    warnings.push(`${policy.label} inspection did not run`);
  }

  const markdown = [
    '## Protected CI policy',
    '',
    '| Component | Pinned | Expected upstream | Status |',
    '|-----------|--------|-------------------|--------|',
    `| trusted CI controller | \`${pinned}\` | \`${controllerExpected}\` | ${controllerStatus} |`,
    `| ${policy.label} | \`${safeguardsPinned}\` | \`${policy.expected}\` | ${safeguardsStatus} |`,
    '',
  ].join('\n');
  return { markdown, warnings };
}

function writePolicySummary(filePath, snapshot) {
  if (!filePath) return;
  const report = renderCiPolicyReport(snapshot);
  fs.appendFileSync(filePath, report.markdown);
  for (const warning of report.warnings) {
    console.log(`::warning title=CI policy inspection::${warning}`);
  }
}

function policyFailureSummary(snapshot) {
  return ['provenance', 'rollout'].flatMap((name) => {
    const result = snapshot.checks[name];
    if (result.status === 'pass') return [];
    if (result.status === 'error') return [`${name}: ${result.error}`];
    if (name === 'rollout') return result.details.missing;
    return [`${name}: not in protected history`];
  }).join(', ');
}

export async function runCiPolicyInspector(argv, { token = process.env.GH_TOKEN, requestJson } = {}) {
  let options;
  try {
    options = parseCiPolicyArguments(argv);
  } catch (error) {
    console.error(`ci-policy-inspection: ${error.message}`);
    return 2;
  }

  try {
    const workflows = options.workflows.map(repositoryFile);
    let snapshot;
    if (!token) {
      snapshot = emptySnapshot();
      snapshot.checks.provenance = checkResult('error', null, 'GH_TOKEN is required');
      snapshot.checks.rollout = checkResult('error', null, 'GH_TOKEN is required');
    } else {
      snapshot = await inspectCiPolicyProtections({ workflows, token, requestJson });
    }
    snapshot = await inspectCiPolicyFreshness({ inspection: snapshot, token, requestJson });
    writeSnapshot(options.output, snapshot);
    writePolicySummary(options.summary, snapshot);
    if (!policyChecksPass(snapshot)) {
      console.error(`ci-policy-inspection: report detected issues: ${policyFailureSummary(snapshot)}`);
    } else {
      console.log(`CI policy safeguards verified for ${snapshot.policy.branch}`);
    }
    return 0;
  } catch (error) {
    console.error(`ci-policy-inspection: ${error.message}`);
    return 0;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = await runCiPolicyInspector(process.argv.slice(2));
}
