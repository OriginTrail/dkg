/**
 * The daemon refuses to start with API authentication off on an apiHost that is
 * not loopback, and does so before anything listens: the public-checkpoint
 * status server and the API both bind apiHost.
 *
 * Pattern: the shared mocked lifecycle fixture. `node:http`'s createServer is
 * mocked, so nothing really listens, and `DKGAgent.create` rejects with a
 * sentinel: a boot that gets that far was not refused.
 */
import { describe, expect, it } from 'vitest';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { apiBindRefusal } from '../src/daemon/api-bind-guard.js';
import { isLoopbackApiHost } from '../src/daemon/api-host.js';
import {
  closeDashboardDbFromAgentCreateArg,
  daemonWiringMocks as mocks,
  installDaemonLifecycleWiringFixture,
  runDaemonInner,
} from './helpers/daemon-lifecycle-wiring.js';

describe('isLoopbackApiHost', () => {
  it.each([
    [undefined], [''], ['127.0.0.1'], ['127.1.2.3'], ['localhost'], ['LOCALHOST'], ['::1'], ['[::1]'], ['::ffff:127.0.0.1'],
  ])('treats %j as loopback', (host) => {
    expect(isLoopbackApiHost(host)).toBe(true);
  });

  it.each([
    ['0.0.0.0'], ['::'], ['[::]'], ['192.168.1.20'], ['10.0.0.5'], ['::ffff:10.0.0.5'], ['fe80::1'], ['node.example.com'],
    ['localhost.example.com'], ['128.0.0.1'],
  ])('treats %j as reachable from other machines', (host) => {
    expect(isLoopbackApiHost(host)).toBe(false);
  });
});

describe('apiBindRefusal', () => {
  it('refuses only authentication off on a host that is not loopback', () => {
    expect(apiBindRefusal({ apiHost: '0.0.0.0', auth: { enabled: false } })).toMatch(/auth\.enabled: false.*"0\.0\.0\.0"/);
    expect(apiBindRefusal({ apiHost: '192.168.1.20', auth: { enabled: false } })).not.toBeNull();
    expect(apiBindRefusal({ apiHost: '0.0.0.0' })).toBeNull();
    expect(apiBindRefusal({ apiHost: '0.0.0.0', auth: { enabled: true } })).toBeNull();
    expect(apiBindRefusal({ apiHost: '0.0.0.0', auth: {} })).toBeNull();
    expect(apiBindRefusal({ apiHost: '127.0.0.1', auth: { enabled: false } })).toBeNull();
    expect(apiBindRefusal({ auth: { enabled: false } })).toBeNull();
  });
});

describe('runDaemonInner with authentication off', () => {
  const fixture = installDaemonLifecycleWiringFixture();

  /** Boot with the fixture's usual node config and `overrides`; close what a boot that reached the agent opened. */
  async function boot(overrides: Record<string, unknown>): Promise<void> {
    const before = mocks.agentCreate.mock.calls.length;
    try {
      await runDaemonInner(true, {
        name: 'api-bind-guard-test',
        networkConfig: 'mainnet-gnosis',
        listenPort: 0,
        nodeRole: 'core',
        chain: {
          type: 'evm',
          rpcUrl: 'https://private-rpc.example',
          hubAddress: '0x1234567890123456789012345678901234567890',
          chainId: 'evm:100',
          receiptTimeoutMs: 1_200_000,
        },
        ...overrides,
      } as never, Date.now(), resolveShutdownPolicy(undefined));
    } finally {
      for (const [createArg] of mocks.agentCreate.mock.calls.slice(before)) closeDashboardDbFromAgentCreateArg(createArg);
    }
  }

  it.each([['0.0.0.0'], ['::'], ['192.168.1.20']])(
    'refuses apiHost %j before anything listens or the agent is created', async (apiHost) => {
      await expect(boot({ apiHost, auth: { enabled: false } })).rejects.toThrow(/^Refusing to start: API authentication is off/);
      expect(mocks.createServer).not.toHaveBeenCalled();
      expect(mocks.agentCreate).not.toHaveBeenCalled();
      expect(fixture.stdoutLines.join('')).toContain(`FATAL: API authentication is off (auth.enabled: false) and apiHost is "${apiHost}"`);
    },
  );

  it('starts with authentication off on loopback, and with authentication on any host', async () => {
    await expect(boot({ apiHost: '127.0.0.1', auth: { enabled: false } })).rejects.toThrow('after-agent-create');
    await expect(boot({ apiHost: '0.0.0.0' })).rejects.toThrow('after-agent-create');
    expect(mocks.agentCreate).toHaveBeenCalledTimes(2);
  });
});
