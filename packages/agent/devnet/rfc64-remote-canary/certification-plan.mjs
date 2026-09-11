// SPDX-License-Identifier: Apache-2.0

const PLANNED = 'PLANNED';
const EVIDENCE_REQUIRED = 'EVIDENCE_REQUIRED';

/** Compile every conditional check once for planning, dispatch, and completion. */
export function createCertificationPlanV1(config) {
  const liveSwmPropagation = config.contextGraphs.map((_, index) => descriptor(
    `live-swm-propagation:${index}`,
    ['liveSwmPropagation', index],
    PLANNED,
  ));
  const offlineCatchup = descriptor(
    'offline-catchup',
    ['offlineCatchup'],
    config.lifecycle === null ? EVIDENCE_REQUIRED : PLANNED,
  );
  const vmParity = config.contextGraphs.map((entry, index) => descriptor(
    `vm-parity:${index}`,
    ['vmParity', index],
    entry.vmAskSparql === undefined ? EVIDENCE_REQUIRED : PLANNED,
  ));
  const catalogSwm = config.contextGraphs.map((entry, index) => descriptor(
    `catalog-swm:${index}`,
    ['catalogSwm', index],
    entry.catalogSwmAskSparql === undefined ? EVIDENCE_REQUIRED : PLANNED,
  ));
  const authorization = Object.freeze({
    unauthorized: descriptor(
      'authorization:unauthorized',
      ['authorization', 'unauthorized'],
      stateForExposedCheck(config.authorizationChecks.unauthorized),
    ),
    revoked: descriptor(
      'authorization:revoked',
      ['authorization', 'revoked'],
      stateForExposedCheck(config.authorizationChecks.revoked),
    ),
  });
  const rpcUsage = descriptor(
    'rpc-usage',
    ['rpcUsage'],
    config.rpcUsage.kind === 'required' ? EVIDENCE_REQUIRED : PLANNED,
  );
  const evidence = Object.freeze([
    ...liveSwmPropagation,
    offlineCatchup,
    ...vmParity,
    ...catalogSwm,
    authorization.unauthorized,
    authorization.revoked,
    rpcUsage,
  ]);
  return Object.freeze({
    preflight: Object.freeze({ summary: 'exact-build-network-sync-and-catalog-mode' }),
    liveSwmPropagation: Object.freeze(liveSwmPropagation),
    offlineCatchup,
    vmParity: Object.freeze(vmParity),
    catalogSwm: Object.freeze(catalogSwm),
    authorization,
    rpcUsage,
    evidence,
  });
}

/** Preserve the operator-facing plan while deriving it from canonical descriptors. */
export function serializeCertificationDryRunPlanV1(plan) {
  return Object.freeze({
    preflight: plan.preflight.summary,
    liveSwmPropagationChecks: plan.liveSwmPropagation.length,
    offlineCatchup: plan.offlineCatchup.state,
    vmParityChecks: plan.vmParity.length,
    vmParityEvidence: summarize(plan.vmParity),
    catalogSwmEvidence: summarize(plan.catalogSwm),
    authorization: Object.freeze({
      unauthorized: plan.authorization.unauthorized.state,
      revoked: plan.authorization.revoked.state,
    }),
    rpcUsage: plan.rpcUsage.state,
  });
}

/** A live certificate is complete only when every planned evidence path passed. */
export function isCertificationCompleteV1(plan, checks) {
  return plan.evidence.every(({ resultPath }) => (
    resultPath.reduce((value, segment) => value?.[segment], checks)?.status === 'PASS'
  ));
}

function descriptor(id, resultPath, state) {
  return Object.freeze({ id, resultPath: Object.freeze(resultPath), state });
}

function stateForExposedCheck(check) {
  return check.kind === 'http' ? PLANNED : EVIDENCE_REQUIRED;
}

function summarize(descriptors) {
  return descriptors.every(({ state }) => state === PLANNED) ? PLANNED : EVIDENCE_REQUIRED;
}
