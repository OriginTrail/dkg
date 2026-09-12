// SPDX-License-Identifier: Apache-2.0

import { failure } from './errors.mjs';
import { parseResponseJsonV1 } from './transport.mjs';

/** @typedef {import('./domain-contract.js').CanaryRequesterV1} CanaryRequesterV1 */
/** @typedef {import('./domain-contract.js').JsonValue} JsonValue */
/** @typedef {import('./domain-contract.js').NormalizedCanaryAuthorizationCheckV1} NormalizedCanaryAuthorizationCheckV1 */

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
 * @param {Readonly<{ unauthorized: NormalizedCanaryAuthorizationCheckV1, revoked: NormalizedCanaryAuthorizationCheckV1 }>} checks
 * @param {CanaryRequesterV1} request
 */
export async function verifyAuthorizationV1(checks, request) {
  const [unauthorized, revoked] = await Promise.all([
    runAuthorizationCheckV1(checks.unauthorized, request),
    runAuthorizationCheckV1(checks.revoked, request),
  ]);
  return Object.freeze({ unauthorized, revoked });
}

/** @param {NormalizedCanaryAuthorizationCheckV1} check @param {CanaryRequesterV1} request */
async function runAuthorizationCheckV1(check, request) {
  if (check.kind === 'not-exposed') {
    return Object.freeze({ status: 'EVIDENCE_REQUIRED', reasonCode: check.reasonCode });
  }
  const response = await request.raw(
    check.node,
    check.method,
    check.path,
    check.body,
    check.authentication,
  );
  if (!check.expectedStatuses.some((status) => status === response.status)) {
    throw failure('authorization-denial-status-mismatch', 'policy');
  }
  const body = parseResponseJsonV1(response, 'authorization-response-malformed');
  const code = jsonPointer(body, check.bodyCodePointer);
  if (typeof code !== 'string' || !check.expectedCodes.includes(code)) {
    throw failure('authorization-denial-code-mismatch', 'policy');
  }
  if (response.status === 404) {
    const control = await request.raw(
      requiredControlNode(check.notFoundControlNode),
      check.method,
      check.path,
      check.body,
      'node',
    );
    if (control.status < 200 || control.status >= 300) {
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
