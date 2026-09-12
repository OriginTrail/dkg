// SPDX-License-Identifier: Apache-2.0

import { failure } from './errors.mjs';
import { collectPrivateGateAuthorizationEvidenceV1 } from './private-gate-evidence.mjs';
/** @typedef {import('./domain-contract.js').CanaryNodeClientV1} CanaryNodeClientV1 */
/** @typedef {import('./domain-contract.js').JsonValue} JsonValue */
/** @typedef {import('./domain-contract.js').NormalizedCanaryAuthorizationCheckV1} NormalizedCanaryAuthorizationCheckV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryPrivateGateEvidenceV1} NormalizedCanaryPrivateGateEvidenceV1 */
/** @typedef {import('./domain-contract.js').RemoteCanaryPrivateGateEvidenceResultV1} RemoteCanaryPrivateGateEvidenceResultV1 */

/** @param {unknown} value @param {string} pointer @returns {unknown} */
function jsonPointer(value, pointer) {
  /** @type {unknown} */
  return pointer.split('/').slice(1).reduce((current, token) => {
    if (current === null || typeof current !== 'object') return undefined;
    const decoded = token.replaceAll('~1', '/').replaceAll('~0', '~');
    return /** @type {Record<string, unknown>} */ (current)[decoded];
  }, value);
}

/**
 * @param {Readonly<{ unauthorized: NormalizedCanaryAuthorizationCheckV1, revoked: NormalizedCanaryAuthorizationCheckV1, companionEvidence: NormalizedCanaryPrivateGateEvidenceV1 | null }>} checks
 * @param {CanaryNodeClientV1} client
 * @param {Readonly<{ readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>, expectedCommit?: string, runStartedAt?: string }>} [context]
 * @returns {Promise<import('./domain-contract.js').RemoteCanaryAuthorizationResultV1>}
 */
export async function verifyAuthorizationV1(checks, client, context = {}) {
  /** @type {Readonly<RemoteCanaryPrivateGateEvidenceResultV1> | null} */
  let companionEvidence = null;
  if (checks.companionEvidence !== null) {
    if (
      typeof context.readFileFn !== 'function'
      || context.expectedCommit === undefined
      || context.runStartedAt === undefined
    ) throw failure('private-gate-evidence-read-failed', 'evidence');
    companionEvidence = await collectPrivateGateAuthorizationEvidenceV1(
      checks.companionEvidence,
      {
        readFileFn: context.readFileFn,
        expectedCommit: context.expectedCommit,
        runStartedAt: context.runStartedAt,
      },
    );
  }
  const [unauthorized, revoked] = await Promise.all([
    runAuthorizationCheckV1(checks.unauthorized, client, companionEvidence),
    runAuthorizationCheckV1(checks.revoked, client, companionEvidence),
  ]);
  return Object.freeze({ unauthorized, revoked, companionEvidence });
}

/** @param {NormalizedCanaryAuthorizationCheckV1} check @param {CanaryNodeClientV1} client @param {Readonly<RemoteCanaryPrivateGateEvidenceResultV1> | null} companionEvidence */
async function runAuthorizationCheckV1(check, client, companionEvidence) {
  if (check.kind === 'not-exposed') {
    if (companionEvidence !== null) {
      return Object.freeze({ status: 'PASS', denialObserved: true });
    }
    return Object.freeze({ status: 'EVIDENCE_REQUIRED', reasonCode: check.reasonCode });
  }
  const response = await client.probeAuthorization(
    check.node,
    {
      method: check.method,
      path: check.path,
      body: check.body,
      authentication: check.authentication,
    },
  );
  if (!check.expectedStatuses.some((status) => status === response.status)) {
    throw failure('authorization-denial-status-mismatch', 'policy');
  }
  const code = jsonPointer(response.body, check.bodyCodePointer);
  if (typeof code !== 'string' || !check.expectedCodes.includes(code)) {
    throw failure('authorization-denial-code-mismatch', 'policy');
  }
  if (response.status === 404) {
    const controlStatus = await client.probeAuthorizationControl(
      requiredControlNode(check.notFoundControlNode),
      {
        method: check.method,
        path: check.path,
        body: check.body,
        authentication: 'node',
      },
    );
    if (controlStatus < 200 || controlStatus >= 300) {
      throw failure('authorization-not-found-control-failed', 'policy');
    }
  }
  return Object.freeze({ status: 'PASS', denialObserved: true });
}

/**
 * @param {import('./domain-contract.js').NormalizedCanaryNodeV1 | undefined} node
 * @returns {import('./domain-contract.js').NormalizedCanaryNodeV1}
 */
function requiredControlNode(node) {
  if (node === undefined) throw failure('authorization-not-found-control-missing', 'policy');
  return node;
}
