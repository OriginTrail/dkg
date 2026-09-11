// SPDX-License-Identifier: Apache-2.0

import { failure, jsonPointer } from './common.mjs';
import { parseResponseJsonV1 } from './transport.mjs';

export async function verifyAuthorizationV1(checks, nodeById, request) {
  const [unauthorized, revoked] = await Promise.all([
    runAuthorizationCheckV1(checks.unauthorized, nodeById, request),
    runAuthorizationCheckV1(checks.revoked, nodeById, request),
  ]);
  return Object.freeze({ unauthorized, revoked });
}

async function runAuthorizationCheckV1(check, nodeById, request) {
  if (check.kind === 'not-exposed') {
    return Object.freeze({ status: 'EVIDENCE_REQUIRED', reasonCode: check.reasonCode });
  }
  const node = nodeById.get(check.nodeId);
  const response = await request.raw(
    node,
    check.method,
    check.path,
    check.body,
    check.authentication,
  );
  if (!check.expectedStatuses.includes(response.status)) {
    throw failure('authorization-denial-status-mismatch', 'authorization');
  }
  if (check.bodyCodePointer !== undefined) {
    const body = parseResponseJsonV1(response, 'authorization-response-malformed');
    const code = jsonPointer(body, check.bodyCodePointer);
    if (!check.expectedCodes.includes(code)) {
      throw failure('authorization-denial-code-mismatch', 'authorization');
    }
  }
  if (response.status === 404) {
    const controlNode = nodeById.get(check.notFoundControlNodeId);
    const control = await request.raw(controlNode, check.method, check.path, check.body, 'node');
    if (control.status < 200 || control.status >= 300) {
      throw failure('authorization-not-found-control-failed', 'authorization');
    }
  }
  return Object.freeze({ status: 'PASS', denialObserved: true });
}
