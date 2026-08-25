import { parse as parseYaml } from 'yaml';
import { TESTNET_CANARY_ROLLOUT_POLICY } from './validate-delta-rollout-ruleset.mjs';

const CHECKOUT_PATTERN = /^actions\/checkout@[0-9a-f]{40}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TRUSTED_SCRIPT_PATTERN = /\btrusted-ci\/scripts\/ci\/(plan-ci|assert-ci-results|inspect-ci-policy)\.mjs\b/g;

// This is the controller's module boundary. Workflow sparse checkouts and the
// scheduled freshness comparison are both validated against this exact list;
// unrelated scripts/ci helpers do not require controller rotation.
export const CONTROLLER_POLICY_FILES = Object.freeze([
  'scripts/ci/plan-ci.mjs',
  'scripts/ci/assert-ci-results.mjs',
  'scripts/ci/inspect-ci-policy.mjs',
  'scripts/ci/trusted-controller-pins.mjs',
  'scripts/ci/validate-delta-rollout-ruleset.mjs',
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
  const expectedPaths = [...CONTROLLER_POLICY_FILES].sort();
  if (
    paths.length !== CONTROLLER_POLICY_FILES.length
    || paths.some((entry) => !CONTROLLER_POLICY_FILES.includes(entry))
    || [...paths].sort().some((entry, index) => entry !== expectedPaths[index])
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
        if (scriptCounts.has(scriptName)) {
          scriptCounts.set(scriptName, scriptCounts.get(scriptName) + 1);
        }
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

export function validateTrustedControllerPins(
  workflows,
  policy = TESTNET_CANARY_ROLLOUT_POLICY,
) {
  const repository = policy?.repository;
  if (typeof repository !== 'string' || repository === '') {
    throw new Error('trusted controller validation requires a canonical repository');
  }
  const allCheckouts = workflows.flatMap((workflow) => (
    trustedControllerCheckouts(workflow.source, workflow.sourceName)
  ));

  for (const checkout of allCheckouts) {
    if (checkout.repository !== repository) {
      throw new Error(`${checkout.sourceName}: job ${checkout.jobName}: trusted checkout must use ${repository}`);
    }
    if (!SHA_PATTERN.test(checkout.ref ?? '')) {
      throw new Error(`${checkout.sourceName}: job ${checkout.jobName}: trusted checkout needs an immutable 40-character ref`);
    }
  }

  const refs = new Set(allCheckouts.map((checkout) => checkout.ref));
  if (refs.size !== 1) {
    throw new Error(`trusted CI controller checkouts use ${refs.size} different refs`);
  }
  const rolloutPhase = validatePolicyGateWiring(workflows);
  return { ref: allCheckouts[0].ref, checkouts: allCheckouts, rolloutPhase };
}

export function validatePolicyGateWiring(workflows) {
  const candidates = workflows.map((workflowFile) => ({
    sourceName: workflowFile.sourceName,
    workflow: parseYaml(workflowFile.source),
  })).filter(({ workflow }) => workflow?.jobs?.['ci-gate']);
  if (candidates.length !== 1) {
    throw new Error(`expected one primary workflow with ci-gate, found ${candidates.length}`);
  }

  const [{ sourceName, workflow }] = candidates;
  const prerequisite = workflow.jobs['ci-policy-prerequisites'];
  const gateNeeds = Array.isArray(workflow.jobs['ci-gate'].needs)
    ? workflow.jobs['ci-gate'].needs
    : [workflow.jobs['ci-gate'].needs].filter(Boolean);
  const gateRequiresPrerequisite = gateNeeds.includes('ci-policy-prerequisites');

  // Controller-policy changes deliberately land before their pin rotates.
  // During that preparation phase, neither half of the runtime wiring may be
  // present: the old pinned aggregate does not yet know the new prerequisite.
  if (!prerequisite && !gateRequiresPrerequisite) return 'prepared';
  if (!prerequisite) {
    throw new Error(`${sourceName}: ci-gate requires a missing ci-policy-prerequisites job`);
  }
  if (!gateRequiresPrerequisite) {
    throw new Error(`${sourceName}: ci-gate must require ci-policy-prerequisites`);
  }
  if (!prerequisite || prerequisite.if !== undefined) {
    throw new Error(`${sourceName}: ci-policy-prerequisites must run unconditionally`);
  }
  const inspectorSteps = (prerequisite.steps ?? []).filter((step) => (
    typeof step?.run === 'string'
    && /\bnode trusted-ci\/scripts\/ci\/inspect-ci-policy\.mjs\b/.test(step.run)
    && /--mode\s+enforce\b/.test(step.run)
  ));
  if (inspectorSteps.length !== 1) {
    throw new Error(`${sourceName}: ci-policy-prerequisites must run the trusted enforcing inspector once`);
  }
  return 'enforced';
}
