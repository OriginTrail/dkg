// SPDX-License-Identifier: Apache-2.0
import type { DkgConfig } from '../config.js';
import { isLoopbackApiHost } from './api-host.js';
import { buildCorsAllowlist } from './http-utils.js';

/**
 * Start-up warnings about an API that other machines may reach, or none when
 * `apiHost` is loopback: one about the bind, and one more when CORS allows every
 * origin there. CORS is `*` for an explicit `corsOrigins: "*"`, and for
 * `apiHost: "0.0.0.0"` with `corsOrigins` unset (`buildCorsAllowlist`).
 */
export function apiExposureWarnings(config: Pick<DkgConfig, 'apiHost' | 'corsOrigins'>): string[] {
  if (isLoopbackApiHost(config.apiHost)) return [];
  const warnings = [
    `apiHost is "${config.apiHost}", which is not a loopback address: other machines may reach the API, and the `
    + 'tokens sent to it cross the network as plain HTTP. Keep apiHost on 127.0.0.1, and reach the node from '
    + 'elsewhere through a reverse proxy that terminates TLS.',
  ];
  // The allowlist does not depend on the port when it is "*".
  if (buildCorsAllowlist(config as DkgConfig, 0) === '*') {
    warnings.push(config.corsOrigins === '*'
      ? 'corsOrigins is "*": any web page a browser opens may call this API and read its answers, for any request '
        + 'it can authenticate. Set corsOrigins to the origins that need the API.'
      : `With apiHost "${config.apiHost}" and corsOrigins unset, CORS allows every origin ("*"): any web page a `
        + 'browser opens may call this API and read its answers, for any request it can authenticate. Set '
        + 'corsOrigins to the origins that need the API, such as the dashboard\'s.');
  }
  return warnings;
}
