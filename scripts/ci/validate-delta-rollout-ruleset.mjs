#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_GATES = Object.freeze(['CI gate', 'EVM integration gate']);

// Input must come from GitHub's effective branch-rules endpoint:
// GET /repos/{owner}/{repo}/rules/branches/{branch}. GitHub has already
// applied active enforcement, include/exclude patterns, and layered rulesets
// to this response. Aggregate every returned rule so protections can be split
// across multiple matching rulesets without weakening the verdict.
export function evaluateEffectiveDeltaRolloutRules({ branch, rules }) {
  if (!Array.isArray(rules)) {
    throw new Error('effective branch rules must be an array');
  }
  const requiredChecks = new Set();
  const sources = new Set();
  let hasPullRequests = false;
  let hasMergeQueue = false;

  for (const rule of rules) {
    if (rule?.ruleset_id !== undefined) sources.add(String(rule.ruleset_id));
    if (rule?.type === 'pull_request') hasPullRequests = true;
    if (rule?.type === 'merge_queue') hasMergeQueue = true;
    if (rule?.type === 'required_status_checks') {
      for (const check of rule?.parameters?.required_status_checks ?? []) {
        if (typeof check?.context === 'string') requiredChecks.add(check.context);
      }
    }
  }

  const missing = [
    ...(!hasPullRequests ? ['pull_request'] : []),
    ...(!hasMergeQueue ? ['merge_queue'] : []),
    ...REQUIRED_GATES.filter((gate) => !requiredChecks.has(gate)),
  ];
  return {
    ok: missing.length === 0,
    branch,
    missing,
    requiredChecks: [...requiredChecks].sort(),
    rulesetIds: [...sources].sort(),
    message: missing.length === 0
      ? `${branch} effective rules require PRs, merge queue, and both aggregate gates`
      : `${branch} effective rules are missing: ${missing.join(', ')}`,
  };
}

function parseArguments(argv) {
  if (argv[0] !== '--branch' || !argv[1] || argv.length !== 3) {
    throw new Error('usage: --branch BRANCH EFFECTIVE_RULES.json');
  }
  return { branch: argv[1], file: argv[2] };
}

export function runDeltaRolloutRulesetValidator(argv) {
  try {
    const { branch, file } = parseArguments(argv);
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    const verdict = evaluateEffectiveDeltaRolloutRules({ branch, rules });
    if (!verdict.ok) throw new Error(verdict.message);
    console.log(verdict.message);
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
