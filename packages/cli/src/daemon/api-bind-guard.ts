// SPDX-License-Identifier: Apache-2.0
import { isLoopbackApiHost } from './api-host.js';

/**
 * Why the daemon must not start with this API configuration, or `null` when it
 * may. With API authentication off (`auth.enabled: false`), the API listens
 * on loopback only.
 */
export function apiBindRefusal(config: {
  apiHost?: string;
  auth?: { enabled?: boolean };
}): string | null {
  if (config.auth?.enabled !== false || isLoopbackApiHost(config.apiHost)) return null;
  return `API authentication is off (auth.enabled: false) and apiHost is "${config.apiHost}", which is not a `
    + 'loopback address. With authentication off, every caller that reaches the API is a node administrator. '
    + 'Turn authentication back on (remove auth.enabled: false), or set apiHost to 127.0.0.1.';
}
