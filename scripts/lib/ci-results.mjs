import { CI_LANES, EVM_SCOPES } from './ci-delta.mjs';

export const PRIMARY_LANE_JOBS = Object.freeze({
  tornado_core: 'tornado-core',
  tornado_blazegraph: 'tornado-blazegraph',
  tornado_publisher: 'tornado-publisher',
  tornado_agent: 'tornado-agent',
  bura_cli: 'bura-cli',
  bura_blazegraph_arm64: 'bura-blazegraph-arm64',
  bura_query: 'bura-supporting',
  kosava_node_ui: 'kosava-node-ui',
  kosava_node_ui_e2e: 'kosava-node-ui-e2e',
  kosava_supporting: 'kosava-supporting',
  kosava_hardhat_plugins: 'kosava-hardhat-plugins',
});

function checkNoFailedJobs(needs, errors) {
  for (const [job, state] of Object.entries(needs)) {
    if (state.result === 'failure' || state.result === 'cancelled') {
      errors.push(`${job} ended with ${state.result}`);
    }
  }
}

function requireSuccess(needs, job, shouldRun, errors) {
  const result = needs[job]?.result;
  if (!result) {
    errors.push(`${job} is missing from the aggregate gate`);
  } else if (shouldRun && result !== 'success') {
    errors.push(`${job} was selected but ended with ${result}`);
  }
}

function checkPlanShape(plan, eventName, errors) {
  if (!plan || typeof plan !== 'object') {
    errors.push('CI plan is missing or is not an object');
    return;
  }
  if (!['full', 'delta', 'docs-only'].includes(plan.mode)) {
    errors.push(`CI plan has invalid mode ${plan.mode}`);
  }
  if (typeof plan.fullCi !== 'boolean' || typeof plan.runNode !== 'boolean') {
    errors.push('CI plan fullCi/runNode flags must be booleans');
  }
  for (const lane of CI_LANES) {
    if (typeof plan.lanes?.[lane] !== 'boolean') {
      errors.push(`CI plan lane ${lane} must be a boolean`);
    }
  }
  if (
    !Array.isArray(plan.evmScopes)
    || plan.evmScopes.some((scope) => !EVM_SCOPES.includes(scope))
    || new Set(plan.evmScopes).size !== plan.evmScopes.length
  ) {
    errors.push('CI plan has an invalid EVM scope matrix');
  }
  if (plan.mode === 'full') {
    if (!plan.fullCi || CI_LANES.some((lane) => plan.lanes?.[lane] !== true)) {
      errors.push('Full CI mode must select every lane');
    }
    if (EVM_SCOPES.some((scope) => !plan.evmScopes?.includes(scope))) {
      errors.push('Full CI mode must select every EVM scope');
    }
  } else if (plan.fullCi) {
    errors.push(`${plan.mode} mode cannot set fullCi=true`);
  }
  if (eventName !== 'pull_request' && plan.mode !== 'full') {
    errors.push(`${eventName || 'unknown'} events must use full CI mode`);
  }
}

export function validatePrimaryResults({ eventName, plan, needs }) {
  const errors = [];
  checkPlanShape(plan, eventName, errors);
  checkNoFailedJobs(needs, errors);
  requireSuccess(needs, 'changes', true, errors);
  requireSuccess(needs, 'build', plan.runNode, errors);

  const needsNodeTestArtifacts = Boolean(
    plan.lanes?.tornado_core
    || plan.lanes?.bura_cli
    || plan.lanes?.kosava_hardhat_plugins
  );
  requireSuccess(needs, 'evm-node-test-artifacts', needsNodeTestArtifacts, errors);
  requireSuccess(
    needs,
    'evm-devnet-test-artifacts',
    Boolean(plan.lanes?.kosava_node_ui_e2e),
    errors,
  );

  for (const [lane, job] of Object.entries(PRIMARY_LANE_JOBS)) {
    requireSuccess(needs, job, Boolean(plan.lanes?.[lane]), errors);
  }

  const contracts = Boolean(plan.lanes?.contracts);
  requireSuccess(needs, 'abi-freshness', contracts, errors);
  const candidateEvent = eventName === 'pull_request' || eventName === 'merge_group';
  requireSuccess(needs, 'solidity', candidateEvent && contracts, errors);
  requireSuccess(needs, 'solidity-coverage', !candidateEvent, errors);
  requireSuccess(
    needs,
    'tornado-static-analysis',
    eventName !== 'pull_request' || contracts,
    errors,
  );

  const selectedNodeLane = Object.keys(PRIMARY_LANE_JOBS)
    .filter((lane) => lane !== 'bura_blazegraph_arm64')
    .some((lane) => plan.lanes?.[lane]);
  if (selectedNodeLane !== Boolean(plan.runNode)) {
    errors.push(`runNode=${plan.runNode} is inconsistent with selected Node lanes`);
  }

  return errors;
}

export function validateEvmResults({ eventName, plan, needs }) {
  const errors = [];
  checkPlanShape(plan, eventName, errors);
  checkNoFailedJobs(needs, errors);
  requireSuccess(needs, 'plan', true, errors);
  requireSuccess(needs, 'evm-integration', plan.evmScopes?.length > 0, errors);
  return errors;
}
