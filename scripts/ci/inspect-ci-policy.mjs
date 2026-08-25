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

export function ciPolicyModeExitCode(snapshot, mode) {
  if (mode === 'report') return 0;
  if (mode !== 'enforce') throw new Error(`unknown inspection mode: ${mode}`);
  return snapshot.prerequisites?.ok === true ? 0 : 1;
}

export async function inspectCiPolicyPrerequisites({
  repository,
  workflows,
  token,
  requestJson = githubRequest,
}) {
  const { branch } = TESTNET_CANARY_ROLLOUT_POLICY;
  const controllerModel = validateTrustedControllerPins(workflows);
  const { controllerBranches, controllerFreshnessBranch } = TESTNET_CANARY_ROLLOUT_POLICY;
  const comparisons = await Promise.all(controllerBranches.map(async (protectedBranch) => {
    const compare = await requestJson(
      `repos/${repository}/compare/${encodeURIComponent(controllerModel.ref)}...${encodeURIComponent(protectedBranch)}`,
      token,
    );
    return { branch: protectedBranch, status: compare?.status ?? 'missing' };
  }));
  const effectiveRules = await githubPaginatedArray(
    `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`,
    token,
    requestJson,
  );
  const effectiveRulesetIds = rulesetIdsRequiringDetails(effectiveRules);
  const rulesets = await Promise.all(effectiveRulesetIds.map((rulesetId) => (
    requestJson(`repos/${repository}/rulesets/${encodeURIComponent(rulesetId)}`, token)
  )));
  const deltaRollout = evaluateEffectiveDeltaRolloutRules({
    repository,
    rules: effectiveRules,
    rulesets,
    policy: TESTNET_CANARY_ROLLOUT_POLICY,
  });

  const provenanceOk = comparisons.some((comparison) => (
    isProtectedHistoryComparison(comparison.status)
  ));
  return {
    version: 1,
    repository,
    branch,
    policy: TESTNET_CANARY_ROLLOUT_POLICY,
    controller: {
      pin: controllerModel.ref,
      protectedBranches: controllerBranches,
      freshnessBranch: controllerFreshnessBranch,
      provenance: {
        status: comparisons.find((comparison) => isProtectedHistoryComparison(comparison.status))?.status
          ?? comparisons.map((comparison) => `${comparison.branch}:${comparison.status}`).join(', '),
        comparisons,
        ok: provenanceOk,
      },
    },
    deltaRollout,
    prerequisites: {
      ok: provenanceOk && deltaRollout.ok,
    },
  };
}

export async function inspectCiPolicyFreshness({
  prerequisites,
  token,
  requestJson = githubRequest,
}) {
  const { repository, controller } = prerequisites;
  if (
    typeof repository !== 'string'
    || typeof controller?.pin !== 'string'
    || typeof controller?.freshnessBranch !== 'string'
  ) {
    throw new Error('prerequisite snapshot is missing controller metadata');
  }

  const controllerFiles = await Promise.all(CONTROLLER_POLICY_FILES.map(async (filePath) => {
    const endpoint = `repos/${repository}/contents/${filePath}`;
    const [pinned, current] = await Promise.all([
      requestJson(`${endpoint}?ref=${encodeURIComponent(controller.pin)}`, token),
      requestJson(`${endpoint}?ref=${encodeURIComponent(controller.freshnessBranch)}`, token),
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

  const driftedFiles = controllerFiles.filter((file) => !file.current).map((file) => file.path);
  return {
    ...prerequisites,
    controller: {
      ...controller,
      tree: { ok: driftedFiles.length === 0, driftedFiles, files: controllerFiles },
    },
    freshness: {
      ok: prerequisites.prerequisites?.ok === true && driftedFiles.length === 0,
    },
  };
}

export function parseCiPolicyArguments(argv) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      repository: { type: 'string' },
      workflow: { type: 'string', multiple: true, default: [] },
      output: { type: 'string' },
      summary: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    !['enforce', 'report'].includes(options.mode)
    || !options.repository
    || options.workflow.length === 0
  ) {
    throw new Error('mode, repository, and at least one workflow are required');
  }
  if (options.summary && options.mode !== 'report') {
    throw new Error('--summary is available only in report mode');
  }
  const { workflow: workflows, ...singleValueOptions } = options;
  return { ...singleValueOptions, workflows };
}

function writeSnapshot(filePath, snapshot) {
  if (filePath) fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function renderCiPolicyReport(snapshot) {
  const warnings = [];
  const controller = snapshot.controller ?? {};
  const pinned = typeof controller.pin === 'string' ? controller.pin.slice(0, 12) : '?';
  const protectedBranches = Array.isArray(controller.protectedBranches)
    ? controller.protectedBranches.join(' or ')
    : 'protected repository history';
  const freshnessBranch = controller.freshnessBranch ?? 'protected rollout branch';
  let controllerExpected = `protected ${protectedBranches} history`;
  let controllerStatus = '⚠ unable to inspect';

  if (snapshot.acquisitionError) {
    warnings.push(`trusted CI controller inspection failed: ${snapshot.acquisitionError}`);
  } else if (controller.provenance?.ok !== true) {
    controllerStatus = '⚠ untrusted provenance';
    warnings.push(`trusted CI controller ${pinned} is not in protected ${protectedBranches} history`);
  } else {
    controllerExpected = `${freshnessBranch} policy tree`;
    if (controller.tree?.ok === true) {
      controllerStatus = '✓ current';
    } else {
      controllerStatus = '⚠ policy drift';
      warnings.push(`trusted CI controller ${pinned} differs from ${freshnessBranch}`);
    }
  }

  const rolloutLabel = snapshot.policy?.label
    ?? `${snapshot.branch ?? TESTNET_CANARY_ROLLOUT_POLICY.branch} delta safeguards`;
  const rolloutExpected = snapshot.policy?.expected ?? TESTNET_CANARY_ROLLOUT_POLICY.expected;
  let safeguardsPinned = '?';
  let safeguardsStatus = '⚠ unable to inspect';
  if (snapshot.deltaRollout?.ok === true) {
    safeguardsPinned = 'active ruleset';
    safeguardsStatus = '✓ current';
  } else if (snapshot.deltaRollout) {
    safeguardsStatus = '⚠ prerequisites missing';
    warnings.push(`${rolloutLabel} missing: ${snapshot.deltaRollout.missing.join(', ')}`);
  } else if (snapshot.acquisitionError) {
    warnings.push(`${rolloutLabel} inspection failed: ${snapshot.acquisitionError}`);
  }

  const markdown = [
    '## Protected CI policy',
    '',
    '| Component | Pinned | Expected upstream | Status |',
    '|-----------|--------|-------------------|--------|',
    `| trusted CI controller | \`${pinned}\` | \`${controllerExpected}\` | ${controllerStatus} |`,
    `| ${rolloutLabel} | \`${safeguardsPinned}\` | \`${rolloutExpected}\` | ${safeguardsStatus} |`,
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

export async function runCiPolicyInspector(argv, { token = process.env.GH_TOKEN, requestJson } = {}) {
  let options;
  let snapshot;
  try {
    options = parseCiPolicyArguments(argv);
    if (!token) throw new Error('GH_TOKEN is required');
    snapshot = await inspectCiPolicyPrerequisites({
      repository: options.repository,
      workflows: options.workflows.map(repositoryFile),
      token,
      requestJson,
    });
    if (options.mode === 'report') {
      snapshot = await inspectCiPolicyFreshness({
        prerequisites: snapshot,
        token,
        requestJson,
      });
    }
    writeSnapshot(options.output, snapshot);
    writePolicySummary(options.summary, snapshot);
    if (!snapshot.prerequisites.ok) {
      console.error(`ci-policy-inspection: prerequisites missing: ${snapshot.deltaRollout.missing.join(', ') || snapshot.controller.provenance.status}`);
    } else {
      console.log(`CI policy prerequisites verified for ${snapshot.branch}`);
    }
    return ciPolicyModeExitCode(snapshot, options.mode);
  } catch (error) {
    const failedSnapshot = {
      ...(snapshot ?? {
        version: 1,
        repository: options?.repository,
        branch: TESTNET_CANARY_ROLLOUT_POLICY.branch,
        policy: TESTNET_CANARY_ROLLOUT_POLICY,
        prerequisites: { ok: false },
      }),
      acquisitionError: error.message,
      freshness: { ok: false },
    };
    writeSnapshot(options?.output, failedSnapshot);
    writePolicySummary(options?.summary, failedSnapshot);
    console.error(`ci-policy-inspection: ${error.message}`);
    return options?.mode === 'report' ? 0 : 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = await runCiPolicyInspector(process.argv.slice(2));
}
