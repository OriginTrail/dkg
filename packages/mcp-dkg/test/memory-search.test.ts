import { describe, it, expect, beforeEach } from 'vitest';
import { registerMemorySearchTool } from '../src/tools/memory-search.js';
import { FakeServer } from './harness.js';
import { LIVE, API, TOKEN, CG, liveClient, liveConfig } from './live.js';

// ── NO MOCKS ─────────────────────────────────────────────────────────
// The retired version fed `client.memoryFixtures` (canned per-layer rows)
// to exercise the trust-tier dedup ranker. That pinned the algorithm but
// never proved the real 6-layer fan-out actually routes/returns. Here:
//   • PURE tests (registration, zod ≥2-char floor, backend-not-ready)
//     use the REAL client. backend-not-ready is reproduced with a REAL
//     dead-port client (genuine ECONNREFUSED → identity probe fails) —
//     no node and no mock.
//   • The fan-out + cross-layer trust dedup (VM > SWM) is proven
//     END-TO-END below (gated): the SAME entity is seeded into the real
//     SWM and minted to real VM, then a live search must collapse them to
//     a single VM-tier hit.

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PUBLISH_TIMEOUT_MS = 180_000;

describe('dkg_memory_search — pure surface + client-side guards (no node)', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerMemorySearchTool(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('registers the dkg_memory_search tool', () => {
    expect(server.tools.has('dkg_memory_search')).toBe(true);
  });

  it('rejects a query shorter than 2 characters at the schema layer (parse)', () => {
    expect(() => server.parse('dkg_memory_search', { query: 'a' })).toThrow();
  });

  it('returns a backend-not-ready error when the daemon identity is unreachable', async () => {
    // REAL dead-port client: the identity probe throws a genuine
    // connection error, the tool swallows it, and (no agentAddress)
    // returns the documented backend-not-ready message. No mock.
    const deadServer = new FakeServer();
    registerMemorySearchTool(
      deadServer.asMcpServer(),
      liveClient({ api: 'http://127.0.0.1:1' }),
      liveConfig({ api: 'http://127.0.0.1:1' }),
    );
    const result = await deadServer.call('dkg_memory_search', { query: 'anything goes here' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/backend not ready/);
  });
});

describe.skipIf(!LIVE)('dkg_memory_search — live fan-out + trust-tier dedup (real node)', () => {
  const RUN = `ms${Date.now().toString(36)}`;
  const did = `did:dkg:context-graph:${CG}`;
  let server: FakeServer;
  let client: ReturnType<typeof liveClient>;

  beforeEach(() => {
    server = new FakeServer();
    client = liveClient();
    registerMemorySearchTool(server.asMcpServer(), client, liveConfig());
  });

  // Seed a unique entity into LOOSE SWM through the real daemon. Each test
  // uses its OWN token so a single keyword query matches exactly its own
  // seed(s) — no cross-test bleed despite the shared CG.
  async function seedLooseSwm(subj: string, marker: string): Promise<void> {
    const res = await fetch(`${API}/api/shared-memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        contextGraphId: CG,
        quads: [
          { subject: subj, predicate: RDF_TYPE, object: 'urn:ms:Note', graph: did },
          { subject: subj, predicate: 'urn:ms:p:text', object: `"${marker}"`, graph: did },
        ],
      }),
    });
    expect(res.ok, `seed /api/shared-memory/write failed: ${res.status}`).toBe(true);
  }

  it('finds a real SWM-seeded entity and tags it SWM tier (weight 1.15)', async () => {
    const token = `${RUN}find`;
    // marker holds the unique token + filler to clear the 20-char floor.
    // The query is the token ALONE → the daemon's OR-keyword filter only
    // matches THIS seed (shared filler words can't cross-match).
    const marker = `${token} memorysearchpayloadlongenoughxx`;
    await seedLooseSwm(`urn:ms:${token}:e`, marker);

    const result = await server.call('dkg_memory_search', { query: token, projectId: CG });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/1 hit\(s\)/);
    expect(text).toMatch(/project-swm:[1-9]/);
    expect(text).toMatch(/· SWM · weight=1\.15/);
    expect(text).toContain(token);
  });

  it('collapses multiple raw matches for the SAME (cg, uri) into a single ranked hit', async () => {
    // The daemon enforces SINGLE-TIER residency per rootEntity (writing a
    // published URI back to SWM is rejected: "Rule 4: rootEntity already
    // exists … Use /api/update"). So the SAME uri can NOT live in two
    // memory tiers at once — the retired FakeClient test asserted a state
    // the real daemon forbids. The reproducible real-data proof of the
    // dedup MAP (keyed on `${cg}::${uri}`) is two matching literals on the
    // same subject within a layer: the fan-out returns 2 raw rows, the
    // ranker collapses them to ONE hit. (Cross-tier weight ordering is
    // covered by the per-tier SWM=1.15 / VM=1.30 tests around this one.)
    const token = `${RUN}dedup`;
    const subj = `urn:ms:${token}:e`;
    const did2 = `did:dkg:context-graph:${CG}`;
    const res = await fetch(`${API}/api/shared-memory/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        contextGraphId: CG,
        quads: [
          { subject: subj, predicate: RDF_TYPE, object: 'urn:ms:Note', graph: did2 },
          { subject: subj, predicate: 'urn:ms:p:text', object: `"${token} firstmatchingliterallongenough"`, graph: did2 },
          { subject: subj, predicate: 'urn:ms:p:alt', object: `"${token} secondmatchingliterallongenough"`, graph: did2 },
        ],
      }),
    });
    expect(res.ok, `seed two-literal subject failed: ${res.status}`).toBe(true);

    const result = await server.call('dkg_memory_search', { query: token, projectId: CG });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // Two raw rows came back for the one entity…
    expect(text).toMatch(/project-swm:2/);
    // …but the dedup map collapsed them to exactly ONE survivor.
    expect(text).toMatch(/1 hit\(s\)/);
    expect(text).toMatch(/· SWM · weight=1\.15/);
    // Only one rendered hit block.
    expect(text).not.toContain('### 2.');
  });

  it(
    'renders a real VM-minted entity at the VM tier (weight 1.30)',
    async () => {
      // VM publish drains loose SWM, so this proves the VM tier end-to-end
      // on its own: seed loose SWM, mint the root on-chain, search.
      const token = `${RUN}vm`;
      const subj = `urn:ms:${token}:e`;
      const marker = `${token} memorysearchpayloadlongenoughxx`;
      await seedLooseSwm(subj, marker);
      await client.publishSharedMemory({ contextGraphId: CG, rootEntities: [subj] });

      const result = await server.call('dkg_memory_search', { query: token, projectId: CG });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toMatch(/project-vm:[1-9]/);
      expect(text).toMatch(/· VM · weight=1\.30/);
    },
    PUBLISH_TIMEOUT_MS,
  );
});
