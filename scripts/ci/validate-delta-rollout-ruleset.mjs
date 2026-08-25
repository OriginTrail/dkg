#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_GATES = Object.freeze(['CI gate', 'EVM integration gate']);

function rulesetCoversBranch(ruleset, branch) {
  const includes = ruleset?.conditions?.ref_name?.include;
  return Array.isArray(includes) && includes.includes(`refs/heads/${branch}`);
}

export function evaluateDeltaRolloutRulesets({ branch, rulesets }) {
  for (const ruleset of rulesets) {
    if (ruleset?.enforcement !== 'active' || !rulesetCoversBranch(ruleset, branch)) continue;
    const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
    const statusRule = rules.find((rule) => rule?.type === 'required_status_checks');
    const requiredChecks = new Set(
      statusRule?.parameters?.required_status_checks?.map((check) => check.context) ?? [],
    );
    const missingGates = REQUIRED_GATES.filter((gate) => !requiredChecks.has(gate));
    const hasPullRequests = rules.some((rule) => rule?.type === 'pull_request');
    const hasMergeQueue = rules.some((rule) => rule?.type === 'merge_queue');
    if (hasPullRequests && hasMergeQueue && missingGates.length === 0) {
      return { ok: true, ruleset: ruleset.name ?? ruleset.id ?? '<unnamed>' };
    }
  }
  return {
    ok: false,
    message: `${branch} needs an active pull-request ruleset with merge queue and both aggregate gates`,
  };
}

function parseArguments(argv) {
  if (argv[0] !== '--branch' || !argv[1] || argv.length < 3) {
    throw new Error('usage: --branch BRANCH RULESET.json [RULESET.json ...]');
  }
  return { branch: argv[1], files: argv.slice(2) };
}

export function runDeltaRolloutRulesetValidator(argv) {
  try {
    const { branch, files } = parseArguments(argv);
    const rulesets = files.map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
    const verdict = evaluateDeltaRolloutRulesets({ branch, rulesets });
    if (!verdict.ok) throw new Error(verdict.message);
    console.log(`${branch} delta prerequisites verified by ruleset ${verdict.ruleset}`);
    return 0;
  } catch (error) {
    console.error(`delta-rollout-ruleset: ${error.message}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runDeltaRolloutRulesetValidator(process.argv.slice(2));
}
