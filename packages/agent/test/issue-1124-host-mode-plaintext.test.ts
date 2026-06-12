/**
 * Issue-liveness repro for GH #1124 — "Public context graphs can't publish to
 * Verifiable Memory — host-mode cores drop the plaintext SWM share, storage-ACK
 * quorum unreachable (NO_DATA_IN_SWM)."
 * https://github.com/OriginTrail/dkg/issues/1124
 *
 * For a PUBLIC / open context graph the publisher fans the SWM share out as
 * PLAINTEXT (there's no curated key to encrypt under). But a sharded storage
 * core running in host-mode ingests SWM gossip through
 * `ingestSwmHostModeEnvelope`, whose `isCiphertext` sniff DROPS every
 * non-ciphertext envelope (`if (!isCiphertext) return;`) before it is ever
 * stored. So the storage core never has the data in its SWM, the storage-ACK
 * read finds `NO_DATA_IN_SWM`, and a public-CG publish can never reach quorum —
 * while the identical private/curated flow (ciphertext) succeeds.
 *
 * This test asserts the CORRECT (post-fix) behaviour — a public-CG plaintext SWM
 * envelope is RETAINED by the host-mode store so it can be served to members and
 * read by the storage-ACK path — so it is RED today (the envelope is dropped,
 * the store stays empty) and turns GREEN once host-mode accepts plaintext for
 * public CGs. Hermetic — one in-process core agent + a tmpdir-backed host store,
 * no network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

const PUBLIC_CG = 'gh1124-public-cg';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  dirs.length = 0;
});

describe('GH #1124 — host-mode cores must retain a public CG plaintext SWM share', () => {
  it('a plaintext (public-CG) SWM gossip envelope is stored, not dropped, by host-mode ingest', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'gh1124-'));
    dirs.push(dataDir);

    const agent = await DKGAgent.create({
      name: 'gh1124-core',
      store: new OxigraphStore(),
      chainAdapter: new NoChainAdapter(),
      nodeRole: 'core',
      dataDir,
    } as never);
    await (agent as any).initializeSwmHostModeStore();
    const hostStore = (agent as any).swmHostModeStore;
    expect(hostStore, 'host-mode store must be initialised for a core node').toBeTruthy();

    // A PUBLIC-CG SWM share: the publisher emits this as PLAINTEXT (no curated
    // key). It is a valid WORKSPACE_PUBLISH gossip envelope whose payload is NOT
    // one of the two encrypted carriers.
    const plaintextPayload = new TextEncoder().encode(
      '<urn:gh1124:thing> <https://schema.org/name> "Public Thing" .',
    );
    const envelope = encodeGossipEnvelope({
      version: GOSSIP_ENVELOPE_VERSION,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
      contextGraphId: PUBLIC_CG,
      agentAddress: '0x1111111111111111111111111111111111111111',
      timestamp: String(1_700_000_000_000),
      signature: new Uint8Array(64),
      payload: plaintextPayload,
    });

    await (agent as any).ingestSwmHostModeEnvelope(PUBLIC_CG, envelope, '12D3KooWPublisher');

    // CORRECT (post-fix): the host-mode store retained the public-CG share so it
    // can satisfy the storage-ACK read + member catchup. Today the plaintext
    // envelope is dropped at the `isCiphertext` gate, so the store is empty.
    const stats = await hostStore.stats();
    expect(stats.totalEntries, 'host-mode store dropped the public-CG plaintext SWM share').toBeGreaterThan(0);

    await agent.stop().catch(() => {});
  }, 30_000);
});
