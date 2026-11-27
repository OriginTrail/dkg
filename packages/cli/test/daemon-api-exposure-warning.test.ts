/**
 * The daemon warns at start-up, before anything listens, when apiHost is not a
 * loopback address, and says so separately when that also opens CORS to every
 * origin.
 *
 * Pattern: the shared mocked lifecycle fixture. `node:http`'s createServer is
 * mocked, so nothing really listens, and `DKGAgent.create` rejects with a
 * sentinel: the warnings must be logged before that point.
 */
import { describe, expect, it } from 'vitest';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { apiExposureWarnings } from '../src/daemon/api-exposure-warning.js';
import {
  closeDashboardDbFromAgentCreateArg,
  daemonWiringMocks as mocks,
  installDaemonLifecycleWiringFixture,
  runDaemonInner,
} from './helpers/daemon-lifecycle-wiring.js';

describe('apiExposureWarnings', () => {
  it.each([[undefined], ['127.0.0.1'], ['localhost'], ['::1']])('says nothing for apiHost %j', (apiHost) => {
    expect(apiExposureWarnings({ apiHost })).toEqual([]);
    expect(apiExposureWarnings({ apiHost, corsOrigins: '*' })).toEqual([]);
  });

  it('warns about a host that is not loopback, and about CORS "*" when 0.0.0.0 leaves corsOrigins unset', () => {
    const [bind, cors, ...rest] = apiExposureWarnings({ apiHost: '0.0.0.0' });
    expect(bind).toMatch(/^apiHost is "0\.0\.0\.0", which is not a loopback address/);
    expect(cors).toMatch(/^With apiHost "0\.0\.0\.0" and corsOrigins unset, CORS allows every origin \("\*"\)/);
    expect(rest).toEqual([]);
  });

  it('warns about CORS only when it allows every origin', () => {
    expect(apiExposureWarnings({ apiHost: '0.0.0.0', corsOrigins: ['https://dashboard.example'] })).toHaveLength(1);
    expect(apiExposureWarnings({ apiHost: '192.168.1.20' })).toHaveLength(1);
    expect(apiExposureWarnings({ apiHost: '::' })).toHaveLength(1);
    const [, cors] = apiExposureWarnings({ apiHost: '192.168.1.20', corsOrigins: '*' });
    expect(cors).toMatch(/^corsOrigins is "\*"/);
  });
});

describe('runDaemonInner with a public apiHost', () => {
  const fixture = installDaemonLifecycleWiringFixture();

  /** Boot until the agent is created; returns the WARNING lines logged before that. */
  async function warningsAtBoot(overrides: Record<string, unknown>): Promise<string[]> {
    fixture.stdoutLines.length = 0;
    const before = mocks.agentCreate.mock.calls.length;
    try {
      await expect(runDaemonInner(true, {
        name: 'api-exposure-warning-test',
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
      } as never, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');
    } finally {
      for (const [createArg] of mocks.agentCreate.mock.calls.slice(before)) closeDashboardDbFromAgentCreateArg(createArg);
    }
    expect(mocks.createServer).not.toHaveBeenCalled();
    return fixture.stdoutLines.join('').split('\n')
      .map((line) => line.replace(/^\[[^\]]+\] /, ''))
      .filter((line) => line.startsWith('WARNING: apiHost') || line.startsWith('WARNING: With apiHost') || line.startsWith('WARNING: corsOrigins'));
  }

  it('logs both warnings for 0.0.0.0 before anything listens', async () => {
    const warnings = await warningsAtBoot({ apiHost: '0.0.0.0' });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^WARNING: apiHost is "0\.0\.0\.0", which is not a loopback address/);
    expect(warnings[1]).toMatch(/^WARNING: With apiHost "0\.0\.0\.0" and corsOrigins unset, CORS allows every origin/);
  });

  it('logs the bind warning alone for a LAN address, and nothing for loopback', async () => {
    expect(await warningsAtBoot({ apiHost: '192.168.1.20' })).toEqual([
      expect.stringMatching(/^WARNING: apiHost is "192\.168\.1\.20"/),
    ]);
    expect(await warningsAtBoot({ apiHost: '127.0.0.1' })).toEqual([]);
    expect(await warningsAtBoot({})).toEqual([]);
  });
});
