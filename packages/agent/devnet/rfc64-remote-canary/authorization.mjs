// SPDX-License-Identifier: Apache-2.0

import { failure, jsonPointer } from './common.mjs';
import { parseResponseJsonV1 } from './transport.mjs';

export async function verifyAuthorizationV1(checks, request) {
  const [unauthorized, revoked] = await Promise.all([
    runAuthorizationCheckV1(checks.unauthorized, request),
    runAuthorizationCheckV1(checks.revoked, request),
  ]);
  return Object.freeze({ unauthorized, revoked });
}

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
  if (!check.expectedStatuses.includes(response.status)) {
    throw failure('authorization-denial-status-mismatch', 'authorization');
  }
  const body = parseResponseJsonV1(response, 'authorization-response-malformed');
  const code = jsonPointer(body, check.bodyCodePointer);
  if (!check.expectedCodes.includes(code)) {
    throw failure('authorization-denial-code-mismatch', 'authorization');
  }
  if (response.status === 404) {
    const control = await request.raw(
      check.notFoundControlNode,
      check.method,
      check.path,
      check.body,
      'node',
    );
    if (control.status < 200 || control.status >= 300) {
      throw failure('authorization-not-found-control-failed', 'authorization');
    }
  }
  return Object.freeze({ status: 'PASS', denialObserved: true });
}
