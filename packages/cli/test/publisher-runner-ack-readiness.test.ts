/**
 * #1404 — CLI publisher ACK readiness-gate wiring.
 *
 * The core-peer readiness gate only protects a production publish if the
 * construction site actually opts in. The daemon publish/update providers are
 * covered in `packages/agent/test/v10-ack-provider-wiring.test.ts`; this file
 * pins the THIRD production site — the CLI publisher runner — so a bare
 * `new ACKCollector(...)` that dropped the readiness opt-in here would be a red
 * test, not silent false confidence.
 *
 * We intercept the centralized `createProductionACKCollector` factory (which
 * injects `DEFAULT_CORE_PEER_READINESS_TIMEOUT_MS` — proven in
 * `packages/publisher/test/v10-ack-edge-cases.test.ts`) and assert the CLI
 * provider routes through it. The provider builder lives in its own intentional
 * internal module (`src/ack-provider.ts`) with a stable contract, so this test
 * imports it there instead of forcing `publisher-runner.ts` to widen its surface.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DKGPublisher } from '@origintrail-official/dkg-publisher';

const capturedFactoryDeps: unknown[] = [];

vi.mock('@origintrail-official/dkg-publisher', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-publisher')>(
    '@origintrail-official/dkg-publisher',
  );
  return {
    ...actual,
    createProductionACKCollector: (deps: unknown) => {
      capturedFactoryDeps.push(deps);
      return {
        async collect(): Promise<never> {
          throw new Error('stub collect() should not run in wiring test');
        },
        async collectUpdate(): Promise<never> {
          throw new Error('stub collectUpdate() should not run in wiring test');
        },
      };
    },
  };
});

// Import AFTER the mock is registered so the CLI module binds the mocked factory.
const { createV10ACKProviderForPublisher } = await import('../src/ack-provider.js');

/** Minimal publisher whose `chain` satisfies every V10 capability guard. */
function fakeV10Publisher(): DKGPublisher {
  return {
    chain: {
      isV10Ready: () => true,
      verifyACKIdentity: async () => true,
      verifyACKIdentityDetailed: async () => ({ valid: true as const }),
      getEvmChainId: async () => 8453n,
      getKnowledgeAssetsLifecycleAddress: async () => `0x${'00'.repeat(20)}`,
    },
  } as unknown as DKGPublisher;
}

function fakeTransport() {
  return {
    publisherPeerId: 'peer-self',
    gossipPublish: async () => undefined,
    sendP2P: async () => new Uint8Array(),
    getConnectedCorePeers: () => ['core-a', 'core-b', 'core-c'],
    log: () => undefined,
  };
}

describe('CLI publisher ACK provider — readiness gate wiring (#1404)', () => {
  it('routes the ACK collector through createProductionACKCollector (readiness opt-in cannot be skipped)', () => {
    capturedFactoryDeps.length = 0;
    const provider = createV10ACKProviderForPublisher(fakeV10Publisher(), fakeTransport());
    expect(provider).toBeTypeOf('function');
    expect(capturedFactoryDeps).toHaveLength(1);
    const deps = capturedFactoryDeps[0] as {
      getConnectedCorePeers?: () => string[];
      corePeerReadinessTimeoutMs?: number;
    };
    expect(deps.getConnectedCorePeers).toBeTypeOf('function');
    // The production factory owns the readiness timeout; the CLI must NOT
    // hand-copy the constant (the centralization this test protects).
    expect(deps.corePeerReadinessTimeoutMs).toBeUndefined();
  });

  it('returns undefined and never constructs a collector when no transport is supplied', () => {
    capturedFactoryDeps.length = 0;
    expect(createV10ACKProviderForPublisher(fakeV10Publisher(), undefined)).toBeUndefined();
    expect(capturedFactoryDeps).toHaveLength(0);
  });
});
