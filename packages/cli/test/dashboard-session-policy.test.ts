import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  isAllowedLoopbackHostname,
  isLoopbackAddress,
} from '../src/daemon/dashboard-session.js';
import { hasTrustedDashboardOrigin } from '../src/daemon/dashboard-session-policy.js';

describe('dashboard session trust policy helpers', () => {
  it('recognizes the loopback address forms accepted for browser bootstrap', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.10.20.30')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });

  it('keeps loopback hostnames narrow for browser-origin proof', () => {
    expect(isAllowedLoopbackHostname('localhost')).toBe(true);
    expect(isAllowedLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isAllowedLoopbackHostname('[::1]')).toBe(true);
    expect(isAllowedLoopbackHostname('example.com')).toBe(false);
  });

  it('trusts HTTPS proxy origins from non-loopback peers only when browser metadata matches Host', () => {
    const matching = {
      headers: {
        host: 'node.example',
        origin: 'https://node.example',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '172.18.0.2' },
    } as IncomingMessage;
    expect(hasTrustedDashboardOrigin(matching)).toBe(true);

    const matchingReferer = {
      headers: {
        host: 'node.example',
        referer: 'https://node.example/dashboard',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '172.18.0.2' },
    } as IncomingMessage;
    expect(hasTrustedDashboardOrigin(matchingReferer)).toBe(true);

    const hostile = {
      headers: {
        host: 'node.example',
        origin: 'https://attacker.example',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '172.18.0.2' },
    } as IncomingMessage;
    expect(hasTrustedDashboardOrigin(hostile)).toBe(false);
  });
});
