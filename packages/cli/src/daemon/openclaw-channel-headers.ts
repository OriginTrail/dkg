// Headers for requests to OpenClaw channel targets. Kept out of `openclaw.ts`, which is at its
// file-size budget; `openclaw.ts` re-exports both functions.

import { isIP } from 'node:net';

import type { OpenClawChannelTarget } from './openclaw.js';

/** True for an http(s) URL on this host's loopback interface: localhost, 127.0.0.0/8 or ::1. */
export function isOpenClawLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "localhost"
      || host === "[::1]"
      || host === "::1"
      || (isIP(host) === 4 && host.startsWith("127."));
  } catch {
    return false;
  }
}

/**
 * Headers for a request to an OpenClaw channel target. The node-operator token (`auth.token`) goes
 * only to the standalone bridge, and only at a loopback URL, as for Hermes and Prime Agent.
 */
export function buildOpenClawChannelHeaders(
  target: OpenClawChannelTarget,
  bridgeAuthToken: string | undefined,
  requestUrl: string | undefined,
  baseHeaders: Record<string, string> = {},
): Record<string, string> {
  if (target.name !== "bridge" || !bridgeAuthToken || !isOpenClawLoopbackUrl(requestUrl)) return baseHeaders;
  return { ...baseHeaders, "x-dkg-bridge-token": bridgeAuthToken };
}
