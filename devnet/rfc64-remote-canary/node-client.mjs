// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { decodeNodeCertificationStatusV1 } from './status-contract.mjs';
import { parseResponseJsonV1 } from './transport.mjs';

/** @typedef {import('./domain-contract.js').CanaryNodeClientV1} CanaryNodeClientV1 */
/** @typedef {import('./domain-contract.js').CanaryAskQueryV1} CanaryAskQueryV1 */
/** @typedef {import('./domain-contract.js').CanaryAuthorizationProbeV1} CanaryAuthorizationProbeV1 */
/** @typedef {import('./domain-contract.js').CanaryRequesterV1} CanaryRequesterV1 */
/** @typedef {import('./domain-contract.js').CanarySwmMarkerShareV1} CanarySwmMarkerShareV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryNodeV1} NormalizedCanaryNodeV1 */

/** Keep every daemon route, payload, and response decoder behind one client. */
/** @param {CanaryRequesterV1} request @returns {Readonly<CanaryNodeClientV1>} */
export function createCanaryNodeClientV1(request) {
  /** @param {NormalizedCanaryNodeV1} node */
  async function readCertificationStatus(node) {
    return decodeNodeCertificationStatusV1(
      await request.json(node, 'GET', '/api/status'),
    );
  }

  /** @param {NormalizedCanaryNodeV1} node @param {CanaryAskQueryV1} query */
  async function askQuery(node, query) {
    const result = await request.json(node, 'POST', '/api/query', query);
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
    const queryResult = /** @type {Record<string, unknown>} */ (result).result;
    return queryResult !== null
      && typeof queryResult === 'object'
      && !Array.isArray(queryResult)
      && /** @type {Record<string, unknown>} */ (queryResult).type === 'boolean'
      && /** @type {Record<string, unknown>} */ (queryResult).value === true;
  }

  /** @param {NormalizedCanaryNodeV1} node @param {CanarySwmMarkerShareV1} marker */
  async function shareSwmMarker(node, marker) {
    const result = await request.json(node, 'POST', '/api/knowledge-assets', marker);
    return result !== null
      && typeof result === 'object'
      && !Array.isArray(result)
      && /** @type {Record<string, unknown>} */ (result).swmShared === true;
  }

  /** @param {NormalizedCanaryNodeV1} node */
  function reachable(node) {
    return request.reachable(node);
  }

  /** @param {NormalizedCanaryNodeV1} node @param {CanaryAuthorizationProbeV1} probe */
  async function probeAuthorization(node, probe) {
    const response = await requestAuthorizationV1(node, probe);
    return Object.freeze({
      status: response.status,
      body: parseResponseJsonV1(response, 'authorization-response-malformed'),
    });
  }

  /**
   * A 404 control proves only that the authenticated route exists. Its success
   * body is deliberately irrelevant and may be empty or non-JSON.
   * @param {NormalizedCanaryNodeV1} node
   * @param {CanaryAuthorizationProbeV1} probe
   */
  async function probeAuthorizationControl(node, probe) {
    return (await requestAuthorizationV1(node, probe)).status;
  }

  /** @param {NormalizedCanaryNodeV1} node @param {CanaryAuthorizationProbeV1} probe */
  function requestAuthorizationV1(node, probe) {
    return request.raw(
      node,
      probe.method,
      probe.path,
      probe.body,
      probe.authentication,
    );
  }

  return Object.freeze({
    readCertificationStatus,
    askQuery,
    shareSwmMarker,
    reachable,
    probeAuthorization,
    probeAuthorizationControl,
  });
}
