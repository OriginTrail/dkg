export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

const ENFORCEMENT_RULE_TYPES = new Set([
  'pull_request',
  'merge_queue',
  'required_status_checks',
]);

export const TESTNET_CANARY_ROLLOUT_POLICY = Object.freeze({
  repository: 'OriginTrail/dkg',
  branch: 'testnet-canary',
  controllerBranches: Object.freeze(['main', 'testnet-canary']),
  controllerFreshnessBranch: 'testnet-canary',
  label: 'testnet-canary delta safeguards',
  expected: 'PR + queue + Actions-owned aggregate gates, no bypass',
  requiredGates: Object.freeze(['CI gate', 'EVM integration gate']),
});

export const REQUIRED_GATES = TESTNET_CANARY_ROLLOUT_POLICY.requiredGates;

export function rulesetIdsRequiringDetails(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('effective branch rules must be an array');
  }
  return [...new Set(rules
    .filter((rule) => ENFORCEMENT_RULE_TYPES.has(rule?.type))
    .map((rule) => rule?.ruleset_id)
    .filter((rulesetId) => rulesetId !== undefined)
    .map(String))];
}

function validateRulesetDetail({ branch, repository, rulesetId, ruleset }) {
  const errors = [];
  if (!ruleset || String(ruleset.id) !== rulesetId) {
    return [`ruleset ${rulesetId} details`];
  }
  if (
    ruleset.enforcement !== 'active'
    || ruleset.source_type !== 'Repository'
    || ruleset.source !== repository
    || ruleset.target !== 'branch'
  ) {
    errors.push(`ruleset ${rulesetId} repository enforcement`);
  }
  const includes = ruleset.conditions?.ref_name?.include;
  if (!Array.isArray(includes) || !includes.includes(`refs/heads/${branch}`)) {
    errors.push(`ruleset ${rulesetId} exact branch binding`);
  }
  if (!Array.isArray(ruleset.bypass_actors)) {
    errors.push(`ruleset ${rulesetId} authoritative bypass configuration`);
  } else if (ruleset.bypass_actors.length > 0) {
    errors.push(`ruleset ${rulesetId} no bypass actors`);
  }
  return errors;
}

// Input must come from GitHub's effective branch-rules endpoint:
// GET /repos/{owner}/{repo}/rules/branches/{branch}. GitHub has already
// applied active enforcement, include/exclude patterns, and layered rulesets
// to this response. Aggregate every returned rule so protections can be split
// across multiple matching rulesets without weakening the verdict.
export function evaluateEffectiveDeltaRolloutRules({
  rules,
  rulesets,
  policy = TESTNET_CANARY_ROLLOUT_POLICY,
}) {
  if (!Array.isArray(rules)) {
    throw new Error('effective branch rules must be an array');
  }
  if (!Array.isArray(rulesets)) {
    throw new Error('effective ruleset details must be an array');
  }
  const { branch } = policy;
  const { repository } = policy;
  const requiredChecks = new Map();
  const sources = new Set();
  const enforcementSources = new Set(rulesetIdsRequiringDetails(rules));
  let hasPullRequests = false;
  let hasMergeQueue = false;

  for (const rule of rules) {
    if (rule?.ruleset_id !== undefined) sources.add(String(rule.ruleset_id));
    if (rule?.type === 'pull_request') hasPullRequests = true;
    if (rule?.type === 'merge_queue') hasMergeQueue = true;
    if (rule?.type === 'required_status_checks') {
      for (const check of rule?.parameters?.required_status_checks ?? []) {
        if (typeof check?.context !== 'string') continue;
        const integrations = requiredChecks.get(check.context) ?? new Set();
        integrations.add(check.integration_id);
        requiredChecks.set(check.context, integrations);
      }
    }
  }

  const rulesetsById = new Map(rulesets.map((ruleset) => [String(ruleset?.id), ruleset]));
  const rulesetErrors = [...enforcementSources].flatMap((rulesetId) => (
    validateRulesetDetail({
      branch,
      repository,
      rulesetId,
      ruleset: rulesetsById.get(rulesetId),
    })
  ));

  const missing = [
    ...(!hasPullRequests ? ['pull_request'] : []),
    ...(!hasMergeQueue ? ['merge_queue'] : []),
    ...policy.requiredGates.filter((gate) => (
      !requiredChecks.get(gate)?.has(GITHUB_ACTIONS_INTEGRATION_ID)
    )).map((gate) => `${gate} from GitHub Actions`),
    ...rulesetErrors,
  ];
  return {
    ok: missing.length === 0,
    branch,
    missing,
    requiredChecks: [...requiredChecks].sort(([left], [right]) => left.localeCompare(right)).map(
      ([context, integrationIds]) => ({
        context,
        integrationIds: [...integrationIds].sort(),
      }),
    ),
    rulesetIds: [...sources].sort(),
    message: missing.length === 0
      ? `${branch} effective rules require PRs, merge queue, and both aggregate gates`
      : `${branch} effective rules are missing: ${missing.join(', ')}`,
  };
}
