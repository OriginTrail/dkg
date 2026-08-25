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
import { evaluateEffectiveDeltaRolloutRules } from './validate-delta-rollout-ruleset.mjs';

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

export async function inspectCiPolicy({
  repository,
  branch,
  workflows,
  token,
  requestJson = githubRequest,
}) {
  const controllerModel = validateTrustedControllerPins(workflows);
  const repositoryMetadata = await requestJson(`repos/${repository}`, token);
  const defaultBranch = repositoryMetadata?.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    throw new Error('repository metadata is missing default_branch');
  }

  const compare = await requestJson(
    `repos/${repository}/compare/${encodeURIComponent(controllerModel.ref)}...${encodeURIComponent(defaultBranch)}`,
    token,
  );
  const effectiveRules = await githubPaginatedArray(
    `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`,
    token,
    requestJson,
  );
  const deltaRollout = evaluateEffectiveDeltaRolloutRules({ branch, rules: effectiveRules });

  const controllerFiles = await Promise.all(CONTROLLER_POLICY_FILES.map(async (filePath) => {
    const endpoint = `repos/${repository}/contents/${filePath}`;
    const [pinned, current] = await Promise.all([
      requestJson(`${endpoint}?ref=${encodeURIComponent(controllerModel.ref)}`, token),
      requestJson(`${endpoint}?ref=${encodeURIComponent(defaultBranch)}`, token),
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

  const provenanceOk = isProtectedHistoryComparison(compare?.status);
  const driftedFiles = controllerFiles.filter((file) => !file.current).map((file) => file.path);
  const snapshot = {
    version: 1,
    repository,
    branch,
    controller: {
      pin: controllerModel.ref,
      defaultBranch,
      provenance: { status: compare?.status ?? 'missing', ok: provenanceOk },
      tree: { ok: driftedFiles.length === 0, driftedFiles, files: controllerFiles },
    },
    deltaRollout,
  };
  snapshot.prerequisites = {
    ok: provenanceOk && deltaRollout.ok,
  };
  snapshot.freshness = {
    ok: snapshot.prerequisites.ok && snapshot.controller.tree.ok,
  };
  return snapshot;
}

export function parseCiPolicyArguments(argv) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      repository: { type: 'string' },
      branch: { type: 'string' },
      workflow: { type: 'string', multiple: true, default: [] },
      output: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    !['enforce', 'report'].includes(options.mode)
    || !options.repository
    || !options.branch
    || options.workflow.length === 0
  ) {
    throw new Error('mode, repository, branch, and at least one workflow are required');
  }
  const { workflow: workflows, ...singleValueOptions } = options;
  return { ...singleValueOptions, workflows };
}

function writeSnapshot(filePath, snapshot) {
  if (filePath) fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function runCiPolicyInspector(argv, { token = process.env.GH_TOKEN, requestJson } = {}) {
  let options;
  try {
    options = parseCiPolicyArguments(argv);
    if (!token) throw new Error('GH_TOKEN is required');
    const snapshot = await inspectCiPolicy({
      repository: options.repository,
      branch: options.branch,
      workflows: options.workflows.map(repositoryFile),
      token,
      requestJson,
    });
    writeSnapshot(options.output, snapshot);
    if (!snapshot.prerequisites.ok) {
      console.error(`ci-policy-inspection: prerequisites missing: ${snapshot.deltaRollout.missing.join(', ') || snapshot.controller.provenance.status}`);
    } else {
      console.log(`CI policy prerequisites verified for ${options.branch}`);
    }
    return ciPolicyModeExitCode(snapshot, options.mode);
  } catch (error) {
    const snapshot = {
      version: 1,
      repository: options?.repository,
      branch: options?.branch,
      acquisitionError: error.message,
      prerequisites: { ok: false },
      freshness: { ok: false },
    };
    writeSnapshot(options?.output, snapshot);
    console.error(`ci-policy-inspection: ${error.message}`);
    return options?.mode === 'report' ? 0 : 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = await runCiPolicyInspector(process.argv.slice(2));
}
