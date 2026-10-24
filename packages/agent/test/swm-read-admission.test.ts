import { DKGAgent } from '../src/dkg-agent.js';
import { resolveContextGraphMetadataConfirmationV1 } from '../src/context-graph-meta-confirmation.js';
import { describe, expect, it } from 'vitest';
import { resolvePrivateRootLegacyLaneAdmission, resolveSharedMemoryAdmission } from '../src/swm-read-admission.js';

describe('shared memory admission dependency outcomes', () => {
  it('identifies each unavailable dependency without turning it into a denial', async () => {
    const error = new Error('dependency unavailable');
    const fail = async () => { throw error; };
    const legacy = () => resolvePrivateRootLegacyLaneAdmission({ authorityId: () => '1',
      mergedMembership: fail, ownMembership: async () => true });
    await expect(legacy()).resolves.toEqual({ outcome: 'unavailable', source: 'legacy-membership', error });
    const reads = { acceptedAuthority: undefined, legacyLane: legacy,
      confirmedMetadata: async () => ({ outcome: 'confirmed' as const }), readAuthority: async () => ({ outcome: 'allowed' as const, grantScope: 'public' as const, source: 'system' as const, reason: 'fixture', metadataBootstrap: 'eligible' as const }) };
    await expect(resolveSharedMemoryAdmission({ ...reads, confirmedMetadata: fail })).rejects.toBe(error);
    const agent = Object.create(DKGAgent.prototype) as DKGAgent;
    Object.defineProperty(agent, 'resolveAcceptedRfc64SharedMemoryAuthorityV1', { value: () => { throw error; } });
    await expect(agent.resolveSharedMemoryReadAdmission('fixture')).rejects.toBe(error);
    await expect(resolveSharedMemoryAdmission({ ...reads, readAuthority: fail })).rejects.toBe(error);
  });

  it('retains the canonical metadata proof and authority decision', async () => {
    const proof = { state: 'unknown' as const, reason: 'rpc-failure' as const, detail: 'fixture' };
    const confirmation = { outcome: 'unavailable' as const, source: 'chain-proof' as const, proof };
    const decision = { outcome: 'unavailable' as const, source: 'registered-chain' as const,
      reason: 'fixture', dependency: 'chain' as const, metadataBootstrap: 'eligible' as const };
    const reads = { acceptedAuthority: undefined, legacyLane: async () => ({ outcome: 'denied' as const }),
      confirmedMetadata: async () => confirmation, readAuthority: async () => decision };
    const metadata = await resolveSharedMemoryAdmission(reads);
    expect(metadata).toEqual({ outcome: 'unavailable', source: 'confirmed-metadata', confirmation });
    if ('confirmation' in metadata && metadata.confirmation.source === 'chain-proof') expect(metadata.confirmation.proof).toBe(proof);
    const authority = await resolveSharedMemoryAdmission({ ...reads, confirmedMetadata: async () => ({ outcome: 'confirmed' }) });
    expect(authority).toEqual({ outcome: 'unavailable', source: 'read-authority', decision });
    if ('decision' in authority) expect(authority.decision).toBe(decision);
  });

  it('preserves cancellation during a dependency failure as cancellation', async () => {
    const controller = new AbortController(), reason = new Error('cancelled');
    await expect(resolveSharedMemoryAdmission({ acceptedAuthority: undefined,
      legacyLane: async () => ({ outcome: 'denied' }), signal: controller.signal,
      confirmedMetadata: async () => { controller.abort(reason); throw new Error('transport closed'); },
      readAuthority: async () => { throw new Error('not reached'); } })).rejects.toBe(reason);
  });
});


it.each([false, true])('metadata dependencies preserve error identity and cancellation (abort=%s)', async abort => {
  const controller = new AbortController(), error = new Error('store unavailable'), reason = new Error('request cancelled');
  await expect(resolveContextGraphMetadataConfirmationV1({
    signal: controller.signal, chain: {} as never, peerId: 'local',
    localApprovedAgentByContextGraph: new Map(), subscriptions: new Map(),
    resolveActivePublicChainProof: async () => { throw new Error('must not read chain'); },
    isPrivateContextGraph: async () => false,
    store: { query: async () => { if (abort) controller.abort(reason); throw error; } } as never,
  }, 'metadata-error')).rejects.toBe(abort ? reason : error);
});

it.each([false, true])('keeps cancellation authoritative around synchronous accepted authority (pre-aborted=%s)', async preAborted => {
  const controller = new AbortController(), reason = new Error('cancelled');
  let calls = 0;
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.defineProperty(agent, 'resolveAcceptedRfc64SharedMemoryAuthorityV1', { value: () => {
    calls++; controller.abort(reason); throw new Error('dependency failed');
  } });
  if (preAborted) controller.abort(reason);
  await expect(agent.resolveSharedMemoryReadAdmission('fixture', { signal: controller.signal })).rejects.toBe(reason);
  expect(calls).toBe(preAborted ? 0 : 1);
});
