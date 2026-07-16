/**
 * Regression (rc.17 D1 wiring): `agent.assertion.create` must not hard-fail on a
 * node that has no `defaultAgentAddress`.
 *
 * When no default agent is registered (e.g. a `NoChainAdapter` node with no
 * operational key), `agentAddress` falls back to the libp2p `peerId` — which is
 * NOT a valid `0x…` EVM address. The D1 create wrapper builds an `allocateKaNumber`
 * callback whenever a `kaNumberAllocator` is wired, and the allocator validates the
 * author via `ethers.getAddress`. Passing the callback unconditionally therefore made
 * `allocator.allocate(peerId)` throw, regressing `create()` from working to
 * hard-failing on every default-agent node.
 *
 * The fix: only pass `allocateKaNumber` for a valid `0x…` author. Non-EVM (peerId)
 * authors fall back to the legacy name-keyed WM graph (no number minted).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

describe('rc.17 D1: default-agent (peerId author) create regression', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  it('agent.assertion.create succeeds on a node with no defaultAgentAddress even when a kaNumberAllocator is wired', async () => {
    agent = await DKGAgent.create({
      name: 'PeerIdAuthorNode',
      listenPort: 0,
      listenHost: '127.0.0.1',
      store: new OxigraphStore(),
      chainAdapter: new NoChainAdapter(),
      nodeRole: 'core',
      skills: [],
      // Wiring the allocator is what (pre-fix) makes the create wrapper build the
      // allocateKaNumber callback — the trigger for the regression.
      kaNumberAllocator: makeTestKaNumberAllocator(),
    });
    await agent.start();

    // No operational key + NoChainAdapter ⇒ no default agent ⇒ agentAddress = peerId (non-EVM).
    expect(agent.getDefaultAgentAddress()).toBeUndefined();

    const cgId = 'peerid-author-cg';
    await agent.createContextGraph({ id: cgId, name: 'PeerId Author CG' });

    // Pre-fix this rejects with "invalid author address: <peerId>".
    const uri = await agent.assertion.create(cgId, 'draft-1');
    expect(uri).toContain(cgId);

    // Round-trip: a peerId-author draft still writes + reads back (legacy name-keyed WM graph).
    await agent.assertion.write(cgId, 'draft-1', [
      { subject: 'urn:peerid:x', predicate: 'http://schema.org/name', object: '"X"' },
    ]);
    const quads = await agent.assertion.query(cgId, 'draft-1');
    expect(quads.map((q) => q.object)).toContain('"X"');
  });
});
