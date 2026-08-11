import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boundary-survival guard for the #2052 Stack D config controls (plan `:1436`).
//
// The agent-package tests prove what the four resolvers and the pick helper DO.
// They cannot prove the controls SURVIVE the trip, because the trip happens
// here: `runDaemonInner` builds `DKGAgent.create({...})` from a hand-written
// per-field mapping, so a control that is declared on `DkgConfig`, documented,
// and settable by an operator still reaches the agent only if this call site
// forwards it. Deleting `...pickSystemRecordConfigControlsV1(config)` from
// `packages/cli/src/daemon/lifecycle.ts` compiles cleanly — every field is
// optional — and leaves the agent-side suite green. It fails HERE.
//
// One-hot on purpose. Four booleans share only two values, so a fixture that
// sets all four `true` and asserts all four `true` passes even when two slots
// are wired from each other's source; each case below rotates a single `true`
// and pins the other three as absent.
//
// Pattern mirrors daemon-sync-agents-meta-wiring.test.ts: mock
// `DKGAgent.create` to capture its options object and reject immediately, so
// `runDaemonInner` unwinds before the heavy post-create boot (HTTP server,
// libp2p). No hardhat, no real chain/network.

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
}));

vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual, // keeps the REAL pickSystemRecordConfigControlsV1 that lifecycle.ts calls
    DKGAgent: { create: mocks.agentCreate },
    loadOpWallets: mocks.loadOpWallets,
    KaNumberAllocator: class KaNumberAllocator {},
  };
});

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadNetworkConfig: mocks.loadNetworkConfig,
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

/** The four controls, in the order plan `:1436` names them. */
const CONTROL_FIELDS = [
  'systemRecordProducerTrackingEnabled',
  'systemRecordProviderAdvertisementEnabled',
  'systemRecordRequesterLaneEnabled',
  'systemRecordLegacyCapablePeerSelectionEnabled',
] as const;

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

describe('runDaemonInner forwards the system-record config controls (:1436)', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-system-record-controls-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    // The resolvers let an env var win over config, so a stray one in the
    // ambient environment could mask a dropped field. Clear all four.
    for (const name of [
      'DKG_SYSTEM_RECORD_PRODUCER_TRACKING_ENABLED',
      'DKG_SYSTEM_RECORD_PROVIDER_ADVERTISEMENT_ENABLED',
      'DKG_SYSTEM_RECORD_REQUESTER_LANE_ENABLED',
      'DKG_SYSTEM_RECORD_LEGACY_CAPABLE_PEER_SELECTION_ENABLED',
    ]) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'core',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.removeAllListeners('uncaughtException');
    for (const listener of uncaughtExceptionListeners) process.on('uncaughtException', listener);
    process.removeAllListeners('unhandledRejection');
    for (const listener of unhandledRejectionListeners) process.on('unhandledRejection', listener);
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    for (const [name, previous] of Object.entries(savedEnv)) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  async function captureCreateArg(configOverrides: Record<string, unknown> = {}): Promise<any> {
    await expect(runDaemonInner(true, {
      name: 'system-record-controls-wiring-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
      ...configOverrides,
    } as any, Date.now())).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    closeDashboardDbFromAgentCreateArg(createArg);
    return createArg;
  }

  for (const field of CONTROL_FIELDS) {
    it(`carries ${field} across the CLI→agent boundary, alone`, async () => {
      const createArg = await captureCreateArg({ [field]: true });

      // Survival: the operator's value reached the agent.
      expect(createArg[field], `${field} was dropped on the CLI→agent hop`).toBe(true);

      // Independence in transit: no sibling slot picked it up.
      for (const other of CONTROL_FIELDS) {
        if (other === field) continue;
        expect(createArg[other], `${field} must not land in ${other}`).toBeUndefined();
      }
    });
  }

  it('carries an explicit false rather than dropping it', async () => {
    // `false` and `undefined` resolve alike today, but they are different
    // operator intents and the hop must not rewrite one into the other.
    const createArg = await captureCreateArg({ systemRecordRequesterLaneEnabled: false });
    expect(createArg.systemRecordRequesterLaneEnabled).toBe(false);
  });

  it('leaves every control undefined when the operator sets none', async () => {
    const createArg = await captureCreateArg();
    for (const field of CONTROL_FIELDS) {
      expect(createArg[field], `${field} must not be invented by the hop`).toBeUndefined();
    }
  });
});
