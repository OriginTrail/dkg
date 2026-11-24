// SPDX-License-Identifier: Apache-2.0
import { isIP } from 'node:net';

/**
 * Whether `apiHost`, as config.json sets it, binds the API to this machine's
 * loopback interface only: unset or empty (the daemon's default, 127.0.0.1),
 * `localhost`, an address in 127.0.0.0/8, `::1`, or an IPv4-mapped loopback
 * address. Anything else, including `0.0.0.0`, `::` and every host name but
 * `localhost`, may be reachable from other machines.
 */
export function isLoopbackApiHost(apiHost: string | undefined): boolean {
  const host = (apiHost ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === '' || host === 'localhost') return true;
  switch (isIP(host)) {
    case 4:
      return host.startsWith('127.');
    case 6: {
      if (host === '::1') return true;
      const mapped = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : '';
      return isIP(mapped) === 4 && mapped.startsWith('127.');
    }
    default:
      return false;
  }
}
