import { describe, expect, it, vi } from 'vitest';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DiscoveryClient } from '../src/discovery.js';
import { buildAgentProfile } from '../src/profile.js';

describe('DiscoveryClient curator peer pagination', () => {
  it('queries distinct peer IDs in deterministic exclusive-cursor order', async () => {
    const query = vi.fn(async () => ({
      type: 'bindings' as const,
      bindings: [
        { peerId: '"peer-011"' },
        { peerId: '"peer-012"' },
      ],
    }));
    const discovery = new DiscoveryClient({ query } as any);

    await expect(discovery.findAgentPeerIdsByAddress(
      '0xabc',
      { afterPeerId: 'peer-010', limit: 2 },
    )).resolves.toEqual(['peer-011', 'peer-012']);

    const [sparql, options] = query.mock.calls[0]!;
    expect(sparql).toContain('SELECT DISTINCT ?peerId');
    expect(sparql).toContain('FILTER(STR(?peerId) > "peer-010")');
    expect(sparql).toContain('ORDER BY ASC(STR(?peerId))');
    expect(sparql).toContain('LIMIT 2');
    expect(options).toMatchObject({ contextGraphId: 'agents' });
  });

  it('pages real agent-registry data without duplicate profile rows', async () => {
    const store = new OxigraphStore();
    const curator = '0x00000000000000000000000000000000000000ab';
    try {
      const first = buildAgentProfile({
        peerId: 'peer-001', name: 'First', agentAddress: curator, skills: [],
      });
      const second = buildAgentProfile({
        peerId: 'peer-002', name: 'Second', agentAddress: curator, skills: [],
      });
      await store.insert([...first.quads, ...second.quads]);
      const discovery = new DiscoveryClient(new DKGQueryEngine(store));

      await expect(discovery.findAgentPeerIdsByAddress(curator, { limit: 1 }))
        .resolves.toEqual(['peer-001']);
      await expect(discovery.findAgentPeerIdsByAddress(
        curator,
        { afterPeerId: 'peer-001', limit: 2 },
      )).resolves.toEqual(['peer-002']);
    } finally {
      await store.close();
    }
  });
});
