import { describe, expect, it, vi } from 'vitest';
import type { Publisher, PublishResult } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import { prepareAgentProfileV1 } from '../src/profile.js';
import { ProfileManager } from '../src/profile-manager.js';

describe('prepared agent profile V1', () => {
  it('samples the implicit timestamp once and returns deep immutable publication quads', () => {
    const now = vi.fn(() => new Date('2026-08-07T12:00:00.000Z'));
    const prepared = prepareAgentProfileV1({
      peerId: 'fixture-peer',
      agentAddress: `0x${'11'.repeat(20)}`,
      name: 'Fixture',
      skills: [],
    }, now);

    expect(now).toHaveBeenCalledTimes(1);
    expect(prepared.lastSeen).toBe('2026-08-07T12:00:00.000Z');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.quads)).toBe(true);
    expect(prepared.quads.every(Object.isFrozen)).toBe(true);
    expect(prepared.quads).toContainEqual(expect.objectContaining({
      predicate: 'https://dkg.network/ontology#lastSeen',
      object: '"2026-08-07T12:00:00.000Z"',
    }));
    expect(prepared.quads).toContainEqual(expect.objectContaining({
      predicate: 'http://www.w3.org/ns/prov#atTime',
      object: '"2026-08-07T12:00:00.000Z"',
    }));
  });

  it('does not call the clock when the caller already supplied lastSeen', () => {
    const now = vi.fn(() => new Date('2026-08-07T12:00:00.000Z'));
    const prepared = prepareAgentProfileV1({
      peerId: 'fixture-peer',
      name: 'Fixture',
      lastSeen: '2026-08-07T11:00:00.000Z',
      skills: [],
    }, now);
    expect(now).not.toHaveBeenCalled();
    expect(prepared.lastSeen).toBe('2026-08-07T11:00:00.000Z');
    expect(prepared.quads).toContainEqual(expect.objectContaining({
      predicate: 'http://www.w3.org/ns/prov#atTime',
      object: '"2026-08-07T11:00:00.000Z"',
    }));
  });

  it('publishes a clone of the exact prepared profile quads', async () => {
    const result = publishResult(7n);
    const publisher = {
      publish: vi.fn(async () => result),
      update: vi.fn(async () => result),
    } as unknown as Publisher;
    const store = {
      query: vi.fn(async () => ({ type: 'bindings', variables: ['s'], bindings: [] })),
      deleteBySubjectPrefix: vi.fn(async () => 0),
    } as unknown as TripleStore;
    const config = {
      peerId: 'fixture-peer', name: 'Fixture', skills: [],
      lastSeen: '2026-08-07T12:00:00.000Z',
    };
    const expected = prepareAgentProfileV1(config);
    const manager = new ProfileManager(publisher, store);
    await manager.publishProfile(config);

    const publishedQuads = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls[0]![0].quads;
    expect(publishedQuads).toEqual(expected.quads);
    expect(publishedQuads).not.toBe(expected.quads);
  });

  it('treats a zero-valued KA id as an existing publication on the next call', async () => {
    const publisher = {
      publish: vi.fn(async () => publishResult(0n)),
      update: vi.fn(async () => publishResult(1n)),
    } as unknown as Publisher;
    const store = {
      query: vi.fn(async () => ({ type: 'bindings', variables: ['s'], bindings: [] })),
      deleteBySubjectPrefix: vi.fn(async () => 0),
    } as unknown as TripleStore;
    const manager = new ProfileManager(publisher, store);
    const config = {
      peerId: 'fixture-peer', name: 'Fixture', skills: [],
      lastSeen: '2026-08-07T12:00:00.000Z',
    };

    await manager.publishProfile(config);
    await manager.publishProfile(config);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.update).toHaveBeenCalledWith(0n, expect.anything());
  });
});

function publishResult(kaId: bigint): PublishResult {
  return {
    kaId,
    ual: 'did:dkg:none/fixture',
    merkleRoot: new Uint8Array(32),
    kaManifest: [],
    status: 'tentative',
  };
}
