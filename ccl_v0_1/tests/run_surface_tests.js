#!/usr/bin/env node

const path = require('node:path');
const { loadYaml, compareExpected, Evaluator } = require('../evaluator/reference_evaluator.js');
const { loadSurfacePolicy } = require('../evaluator/surface_compiler.js');

const ROOT = path.resolve(__dirname, '..');

const suites = [
  {
    name: 'owner_assertion_surface',
    policy: path.join(ROOT, 'examples', 'owner_assertion.ccl'),
    cases: ['01_owner_valid.yaml', '02_owner_invalid.yaml'],
  },
  {
    name: 'context_corroboration_surface',
    policy: path.join(ROOT, 'examples', 'context_corroboration.ccl'),
    cases: [
      '03_context_minimal_corroboration.yaml',
      '04_context_missing_vendor.yaml',
      '05_context_workspace_excluded.yaml',
      '06_context_disputed.yaml',
      '07_context_epoch_mismatch.yaml',
      '08_context_quorum_accept.yaml',
    ],
  },
];

function main() {
  let passed = 0;
  let total = 0;

  for (const suite of suites) {
    const compiled = loadSurfacePolicy(suite.policy);
    for (const caseFile of suite.cases) {
      total += 1;
      const casePath = path.join(ROOT, 'tests', 'cases', caseFile);
      const testCase = loadYaml(casePath);
      const result = new Evaluator(compiled, testCase.facts).run();
      const comparison = compareExpected(result, testCase.expected);
      if (!comparison.ok) {
        console.error(`FAIL ${suite.name} -> ${testCase.name}`);
        console.error(JSON.stringify(comparison.detail, null, 2));
        process.exitCode = 1;
        return;
      }
      passed += 1;
      console.log(`PASS ${suite.name} -> ${testCase.name}`);
    }
  }

  console.log(`\n${passed}/${total} surface cases passed`);
}

main();
