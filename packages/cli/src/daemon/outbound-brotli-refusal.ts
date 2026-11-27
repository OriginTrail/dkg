import { installGlobalBrotliRefusal } from '@origintrail-official/dkg-http-utils';

/**
 * Makes every fetch the daemon makes without a dispatcher of its own refuse
 * Brotli-encoded responses (CVE-2026-111497). Chain RPC calls and local-agent
 * forwards pass their own dispatchers, which refuse them as well. Upgrading
 * Node.js to 22.23.4, 24.22.1, 26.12.1 or later is the fix; this is defence in
 * depth for a node that still runs an affected release.
 */
export function refuseBrotliOnDaemonFetch(log: (message: string) => void): void {
  const refusal = installGlobalBrotliRefusal();
  if (refusal.installed) {
    log('Outbound HTTP refuses Brotli-encoded responses (CVE-2026-111497 hardening)');
  } else {
    log(`WARNING: outbound HTTP may accept Brotli-encoded responses: ${refusal.reason}`);
  }
}
