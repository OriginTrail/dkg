#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  compareExpected,
  loadYaml,
  resolvePolicyPath,
  runCase,
} = require("../evaluator/reference_evaluator.js");

const casesDir = path.resolve(__dirname, "cases");

function main() {
  const caseFiles = fs
    .readdirSync(casesDir)
    .filter((file) => file.endsWith(".yaml"))
    .sort();

  let passed = 0;

  for (const file of caseFiles) {
    const casePath = path.join(casesDir, file);
    const testCase = loadYaml(casePath);
    const policyPath = resolvePolicyPath(casePath, testCase.policy);
    const result = runCase(policyPath, casePath);
    const comparison = compareExpected(result, testCase.expected);

    if (!comparison.ok) {
      console.error(`FAIL ${testCase.name}`);
      console.error(JSON.stringify(comparison.detail, null, 2));
      process.exitCode = 1;
      return;
    }

    passed += 1;
    console.log(`PASS ${testCase.name}`);
  }

  console.log(`\n${passed}/${caseFiles.length} cases passed`);
}

main();
