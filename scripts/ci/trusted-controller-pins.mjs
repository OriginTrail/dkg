#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const CHECKOUT_PATTERN = /^actions\/checkout@[0-9a-f]{40}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TRUSTED_SCRIPT_PATTERN = /\btrusted-ci\/scripts\/ci\/(plan-ci|assert-ci-results)\.mjs\b/g;

// This is the controller's module boundary. Workflow sparse checkouts and the
// scheduled freshness comparison are both validated against this exact list;
// unrelated scripts/ci helpers do not require controller rotation.
export const CONTROLLER_POLICY_FILES = Object.freeze([
  'scripts/ci/plan-ci.mjs',
  'scripts/ci/assert-ci-results.mjs',
  'scripts/lib/ci-delta.mjs',
  'scripts/lib/ci-results.mjs',
]);

export function isProtectedHistoryComparison(status) {
  return status === 'ahead' || status === 'identical';
}

function trustedScriptNames(step) {
  if (typeof step?.run !== 'string') return [];
  return [...step.run.matchAll(TRUSTED_SCRIPT_PATTERN)].map((match) => match[1]);
}

function sparseCheckoutPaths(step, context) {
  const sparseCheckout = step?.with?.['sparse-checkout'];
  if (typeof sparseCheckout !== 'string') {
    throw new Error(`${context}: trusted checkout needs a sparse-checkout file list`);
  }
  const paths = sparseCheckout.split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (
    paths.length !== CONTROLLER_POLICY_FILES.length
    || paths.some((entry, index) => entry !== CONTROLLER_POLICY_FILES[index])
  ) {
    throw new Error(`${context}: trusted checkout must use the canonical controller file list`);
  }
  return paths;
}

export function trustedControllerCheckouts(source, sourceName = '<workflow>') {
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch (error) {
    throw new Error(`${sourceName}: invalid workflow YAML: ${error.message}`);
  }
  if (!workflow?.jobs || typeof workflow.jobs !== 'object' || Array.isArray(workflow.jobs)) {
    throw new Error(`${sourceName}: workflow must contain a jobs mapping`);
  }

  const checkouts = [];
  const scriptCounts = new Map([
    ['plan-ci', 0],
    ['assert-ci-results', 0],
  ]);

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const steps = job?.steps;
    if (!Array.isArray(steps)) continue;

    const consumers = [];
    for (const [stepIndex, step] of steps.entries()) {
      for (const scriptName of trustedScriptNames(step)) {
        consumers.push({ stepIndex, scriptName });
        scriptCounts.set(scriptName, scriptCounts.get(scriptName) + 1);
      }
    }
    if (consumers.length === 0) continue;

    const trustedCheckouts = steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ step }) => step?.with?.path === 'trusted-ci');
    const context = `${sourceName}: job ${jobName}`;
    if (trustedCheckouts.length !== 1) {
      throw new Error(`${context}: expected one trusted-ci checkout, found ${trustedCheckouts.length}`);
    }

    const [{ step, stepIndex }] = trustedCheckouts;
    if (stepIndex >= Math.min(...consumers.map((consumer) => consumer.stepIndex))) {
      throw new Error(`${context}: trusted checkout must precede its controller consumer`);
    }
    if (typeof step.uses !== 'string' || !CHECKOUT_PATTERN.test(step.uses)) {
      throw new Error(`${context}: trusted-ci must use actions/checkout pinned to a 40-character SHA`);
    }
    sparseCheckoutPaths(step, context);
    checkouts.push({
      sourceName,
      jobName,
      uses: step.uses,
      repository: step.with?.repository,
      ref: step.with?.ref,
    });
  }

  for (const [scriptName, count] of scriptCounts) {
    if (count !== 1) {
      throw new Error(`${sourceName}: expected one trusted ${scriptName} consumer, found ${count}`);
    }
  }
  return checkouts;
}

export function validateTrustedControllerPins(workflows) {
  const allCheckouts = workflows.flatMap((workflow) => (
    trustedControllerCheckouts(workflow.source, workflow.sourceName)
  ));

  for (const checkout of allCheckouts) {
    if (checkout.repository !== 'OriginTrail/dkg') {
      throw new Error(`${checkout.sourceName}: job ${checkout.jobName}: trusted checkout must use OriginTrail/dkg`);
    }
    if (!SHA_PATTERN.test(checkout.ref ?? '')) {
      throw new Error(`${checkout.sourceName}: job ${checkout.jobName}: trusted checkout needs an immutable 40-character ref`);
    }
  }

  const refs = new Set(allCheckouts.map((checkout) => checkout.ref));
  if (refs.size !== 1) {
    throw new Error(`trusted CI controller checkouts use ${refs.size} different refs`);
  }
  return { ref: allCheckouts[0].ref, checkouts: allCheckouts };
}

function workflowFromPath(filePath) {
  return {
    sourceName: filePath,
    source: fs.readFileSync(filePath, 'utf8'),
  };
}

export function runTrustedControllerValidator(argv) {
  try {
    if (argv.length === 1 && argv[0] === '--list-controller-files') {
      console.log(CONTROLLER_POLICY_FILES.join('\n'));
      return 0;
    }
    if (argv.length === 2 && argv[0] === '--validate-provenance-status') {
      if (!isProtectedHistoryComparison(argv[1])) {
        throw new Error(`controller comparison status is ${argv[1] || 'missing'}`);
      }
      console.log(`controller is reachable from protected history (${argv[1]})`);
      return 0;
    }
    if (argv.length === 0) throw new Error('provide at least one workflow path');
    const result = validateTrustedControllerPins(argv.map(workflowFromPath));
    console.log(result.ref);
    return 0;
  } catch (error) {
    console.error(`trusted-controller-pins: ${error.message}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runTrustedControllerValidator(process.argv.slice(2));
}
