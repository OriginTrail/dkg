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
  });

  it('hands the same prepared profile to the optional hooks and legacy publisher', async () => {
    const result = publishResult(7n);
    const publisher = {
      publish: vi.fn(async () => result),
      update: vi.fn(async () => result),
    } as unknown as Publisher;
    const store = {
      query: vi.fn(async () => ({ type: 'bindings', variables: ['s'], bindings: [] })),
      deleteBySubjectPrefix: vi.fn(async () => 0),
    } as unknown as TripleStore;
    const seen: unknown[] = [];
    const hooks = {
      beforePublish: vi.fn((input) => { seen.push(input.prepared); }),
      afterPublish: vi.fn((input) => { seen.push(input.prepared); }),
      publishFailed: vi.fn(),
    };
    const manager = new ProfileManager(publisher, store, hooks);
    await manager.publishProfile({
      peerId: 'fixture-peer', name: 'Fixture', skills: [],
      lastSeen: '2026-08-07T12:00:00.000Z',
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(hooks.beforePublish).toHaveBeenCalledWith(expect.objectContaining({ operation: 'publish' }));
    expect(hooks.afterPublish).toHaveBeenCalledWith(expect.objectContaining({ result }));
    expect(hooks.publishFailed).not.toHaveBeenCalled();
    const publishedQuads = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls[0]![0].quads;
    expect(publishedQuads).toEqual((seen[0] as { quads: unknown[] }).quads);
    expect(publishedQuads).not.toBe((seen[0] as { quads: unknown[] }).quads);
  });

  it('retains the completed legacy publication identity when the post-publish hook fails', async () => {
    const result = publishResult(9n);
    const publisher = {
      publish: vi.fn(async () => result),
      update: vi.fn(async () => result),
    } as unknown as Publisher;
    const store = {
      query: vi.fn(async () => ({ type: 'bindings', variables: ['s'], bindings: [] })),
      deleteBySubjectPrefix: vi.fn(async () => 0),
    } as unknown as TripleStore;
    const failure = vi.fn();
    const manager = new ProfileManager(publisher, store, {
      beforePublish: () => {},
      afterPublish: () => { throw new Error('record install failed'); },
      publishFailed: failure,
    });
    const config = {
      peerId: 'fixture-peer', name: 'Fixture', skills: [],
      lastSeen: '2026-08-07T12:00:00.000Z',
    };

    await expect(manager.publishProfile(config)).rejects.toThrow(/record install failed/);
    expect(manager.profileKcId).toBe(9n);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ operation: 'publish' }));
    await expect(manager.publishProfile(config)).rejects.toThrow(/record install failed/);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.update).toHaveBeenCalledTimes(1);
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
    const operations: string[] = [];
    const manager = new ProfileManager(publisher, store, {
      beforePublish: ({ operation }) => { operations.push(operation); },
      afterPublish: () => {},
    });
    const config = {
      peerId: 'fixture-peer', name: 'Fixture', skills: [],
      lastSeen: '2026-08-07T12:00:00.000Z',
    };

    await manager.publishProfile(config);
    await manager.publishProfile(config);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.update).toHaveBeenCalledWith(0n, expect.anything());
    expect(operations).toEqual(['publish', 'update']);
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
