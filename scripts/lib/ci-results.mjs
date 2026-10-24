import {
  CI_LANES,
  EVM_SCOPES,
  NODE_EVM_LANES,
  PRIMARY_LANE_JOBS,
  needsNodeTestArtifacts,
  needsSharedBuild,
} from './ci-delta.mjs';

export { PRIMARY_LANE_JOBS } from './ci-delta.mjs';

// Pinned obligations, matched against Vitest's executed assertions. A green
// generic suite or a runtime guard skipping the transport cases is insufficient.
export const NODE26_REQUIRED_ASSERTIONS = Object.freeze([
  'stay on HTTP/1.1 where a plain fetch negotiates HTTP/2',
  'go through a dispatcher the application installed, with its own TLS trust',
  'go through the proxy of NODE_USE_ENV_PROXY',
  'stay on HTTP/1.1 when a chain RPC call is the first request of a fresh process',
].map((name) => `chain RPC fetches against a server that offers HTTP/2 (#2828) ${name}`));

export function validateNode26Evidence(evidence) {
  const errors = [];
  if (!evidence || evidence.version !== 1) return ['Node 26 execution evidence is missing or has an invalid version'];
  if (!/^26\.\d+\.\d+$/.test(evidence.node ?? '') || !/^8\.\d+\.\d+$/.test(evidence.undici ?? '')) {
    errors.push(`Node 26 execution requires Node 26 / undici 8, got ${evidence.node} / ${evidence.undici}`);
  }
  if (evidence.requireUndici8Fetch !== true) errors.push('Node 26 execution did not require DKG_REQUIRE_UNDICI8_FETCH=1');
  if (evidence.success !== true) errors.push('Node 26 test execution did not succeed');
  if (!Array.isArray(evidence.assertions)) return [...errors, 'Node 26 executed assertions are missing'];
  for (const name of NODE26_REQUIRED_ASSERTIONS) {
    const matches = evidence.assertions.filter((assertion) => assertion?.name === name);
    if (matches.length !== 1 || matches[0].status !== 'passed') {
      errors.push(`Node 26 required assertion did not pass exactly once: ${name}`);
    }
  }
  return errors;
}

function checkNode26Execution(plan, needs, errors) {
  if (plan.lanes?.chain_rpc_node26 !== true) return;
  let evidence;
  try {
    evidence = JSON.parse(needs['chain-rpc-node26']?.outputs?.evidence ?? 'null');
  } catch {
    errors.push('Node 26 execution evidence is not valid JSON');
    return;
  }
  errors.push(...validateNode26Evidence(evidence));
}

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
  if (
    typeof plan.fullCi !== 'boolean'
    || typeof plan.buildChecks !== 'boolean'
    || typeof plan.abiFreshnessRelevant !== 'boolean'
  ) {
    errors.push('CI plan fullCi/buildChecks/abiFreshnessRelevant flags must be booleans');
  }
  if (plan.lanes?.contracts && !plan.abiFreshnessRelevant) {
    errors.push('CI plan cannot select Solidity without ABI freshness');
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
    if (!plan.fullCi || NODE_EVM_LANES.some((lane) => plan.lanes?.[lane] !== true)) {
      errors.push('Full CI mode must select every Node/EVM lane');
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
  // The same rule emits the build job's run_node condition, so the job and
  // this requirement cannot disagree.
  requireSuccess(needs, 'build', needsSharedBuild(plan), errors);

  requireSuccess(needs, 'evm-node-test-artifacts', needsNodeTestArtifacts(plan), errors);
  requireSuccess(
    needs,
    'evm-devnet-test-artifacts',
    Boolean(plan.lanes?.kosava_node_ui_e2e),
    errors,
  );

  for (const [lane, job] of Object.entries(PRIMARY_LANE_JOBS)) {
    requireSuccess(needs, job, Boolean(plan.lanes?.[lane]), errors);
  }
  checkNode26Execution(plan, needs, errors);
  // ci.yml runs the Windows lifecycle workflow (persistence suites and the
  // RFC-64 Gate 0 and evidence harnesses) wherever the agent lane runs.
  requireSuccess(needs, 'inventory-windows', Boolean(plan.lanes?.tornado_agent), errors);

  const contracts = Boolean(plan.lanes?.contracts);
  requireSuccess(needs, 'abi-freshness', Boolean(plan.abiFreshnessRelevant), errors);
  const candidateEvent = eventName === 'pull_request' || eventName === 'merge_group';
  requireSuccess(needs, 'solidity', candidateEvent && contracts, errors);
  requireSuccess(
    needs,
    'solidity-coverage',
    !candidateEvent,
    errors,
  );
  requireSuccess(
    needs,
    'tornado-static-analysis',
    eventName !== 'pull_request' || contracts,
    errors,
  );

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
