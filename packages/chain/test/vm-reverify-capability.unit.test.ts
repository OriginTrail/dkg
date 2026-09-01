/**
 * W2 (#2435, review r4) — the typed re-verification capability probe.
 *
 * One function answers for every adapter class: the mock (and EVM) adapters
 * define the optional operations and probe supported; `NoChainAdapter` and
 * pre-branch adapters fail closed with the missing piece NAMED. The
 * fail-closed directions each get a failure-shaped assertion because the
 * invisible failure mode — a gate that reports capable and arms a lane that
 * yields nothing — is the one this probe exists to end.
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES,
  NoChainAdapter,
  VM_REVERIFY_REQUIRED_OPERATIONS,
  probeVmReverifyCapability,
} from '../src/index.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import type { ChainAdapter } from '../src/chain-adapter.js';

function capableDouble(overrides: Record<string, unknown> = {}): ChainAdapter {
  return {
    supportsEventTypes: async () => [],
    getDKGKnowledgeAssetsAddress: async () => '0x' + '11'.repeat(20),
    getKAContextGraphId: async () => 1n,
    readKnowledgeAssetVersionSnapshot: async () => ({}),
    ...overrides,
  } as unknown as ChainAdapter;
}

describe('probeVmReverifyCapability', () => {
  it('the mock adapter probes SUPPORTED', async () => {
    const result = await probeVmReverifyCapability(new MockChainAdapter() as unknown as ChainAdapter);
    expect(result).toEqual({ supported: true });
  });

  it('NoChainAdapter fails closed with the event capability named', async () => {
    const result = await probeVmReverifyCapability(new NoChainAdapter() as unknown as ChainAdapter);
    expect(result).toEqual({
      supported: false,
      reason: `abi-missing:${KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES[0]}`,
    });
  });

  it('a partial missing-list names the FIRST unservable event kind', async () => {
    const result = await probeVmReverifyCapability(capableDouble({
      supportsEventTypes: async () => ['KnowledgeAssetMerkleRootRemoved'],
    }));
    expect(result).toEqual({
      supported: false,
      reason: 'abi-missing:KnowledgeAssetMerkleRootRemoved',
    });
  });

  it('a probe throw is abi-probe-failed, not capability', async () => {
    const result = await probeVmReverifyCapability(capableDouble({
      supportsEventTypes: async () => { throw new Error('Hub unreachable'); },
    }));
    expect(result).toEqual({ supported: false, reason: 'abi-probe-failed' });
  });

  it('a non-array probe answer fails closed the same way', async () => {
    const result = await probeVmReverifyCapability(capableDouble({
      supportsEventTypes: async () => undefined as never,
    }));
    expect(result).toEqual({ supported: false, reason: 'abi-probe-failed' });
  });

  for (const operation of VM_REVERIFY_REQUIRED_OPERATIONS) {
    it(`emitting alone is not capability: missing ${operation} is named`, async () => {
      const result = await probeVmReverifyCapability(capableDouble({ [operation]: undefined }));
      expect(result).toEqual({ supported: false, reason: `adapter-missing:${operation}` });
    });
  }
});
