/**
 * Harness smoke test — validates devnet/_bootstrap/harness.ts against a live
 * devnet before the 10.0.2 PR-coverage suites are built on top of it.
 * Run: pnpm vitest run --config devnet/_bootstrap/vitest.config.ts
 * Precondition: ./scripts/devnet.sh start 6
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  publishViaCli,
  queryNode,
  makeNquadsFile,
  createFreshPca,
  CONTEXT_GRAPH,
  type DevnetState,
} from './harness.js';

const state: { v: DevnetState | null } = { v: null };

describe('harness smoke', () => {
  beforeAll(async () => {
    state.v = await detectDevnet();
    if (!state.v) throw new Error('Devnet not running. ./scripts/devnet.sh start 6 first.');
    await ensureAllIdentities(state.v, 4);
  }, 180_000);

  it('detects devnet + resolves contracts', async () => {
    const s = state.v!;
    expect(s.addrs.Token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(s.addrs.DKGPublishingConvictionNFT).toMatch(/^0x[0-9a-fA-F]{40}$/);
    for (let n = 1; n <= 4; n++) expect(s.nodes[n]!.identityId).toBeGreaterThan(0n);
  }, 30_000);

  it('publishes from node1 and reads it back via query', async () => {
    const s = state.v!;
    const node1 = s.nodes[1]!;
    const { path, subject } = makeNquadsFile(import.meta.dirname, 'smoke', CONTEXT_GRAPH);
    const pub = await publishViaCli(node1, CONTEXT_GRAPH, path);
    expect(pub.kaId).toBeGreaterThan(0n);

    const bindings = await queryNode(
      node1,
      `SELECT ?o WHERE { <${subject}> <https://schema.org/name> ?o }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(bindings.length).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('creates an isolated fresh PCA (no real-entity mutation)', async () => {
    const s = state.v!;
    const pca = await createFreshPca(s, { committedTrac: ethers.parseEther('500000') });
    expect(pca.accountId).toBeGreaterThan(0n);
    const owner: string = await s.nft.ownerOf(pca.accountId);
    expect(owner.toLowerCase()).toBe(pca.admin.address.toLowerCase());
  }, 120_000);
});
