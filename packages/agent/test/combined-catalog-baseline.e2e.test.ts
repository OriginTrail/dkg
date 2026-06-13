/**
 * OT-RFC-49 combined-model BASELINE (pre-catalog-injection) — curated e2e.
 *
 * The first end-to-end curated/private-CG VM publish on the devnet, via the
 * PRODUCT path (write -> promote -> publishFromFinalizedAssertion). Uses the
 * pre-staked genesis core nodes for the ACK quorum (lowered to 1), so the
 * curated `nodeExists` signer check passes.
 *
 * Baseline invariant: a private CG publishing N data entities yields a KC of
 * exactly N KAs. After the catalog injection lands, the SAME publish yields
 * N+1 KAs (the extra one being the public DCAT catalog KA, subject == CG UAL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import {
  spawnHardhatEnv, killHardhat, setMinimumRequiredSignatures, HARDHAT_KEYS, type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

let ctx: HardhatContext;
const agents: DKGAgent[] = [];

function chainConfig(opKey: string, adminKey: string) {
  return { rpcUrl: ctx.rpcUrl, adminPrivateKey: adminKey, operationalKeys: [opKey], hubAddress: ctx.hubAddress, chainId: 'evm:31337' };
}

// A disk-backed dataDir is REQUIRED for SWM host mode — without it a core cannot
// store the curated ciphertext chunks and declines the ACK (MISSING_CIPHERTEXT_CHUNKS).
const mkDataDir = (name: string) => mkdtempSync(join(tmpdir(), `rfc49-${name}-`));

describe('OT-RFC-49 baseline — curated CG product-path publish (pre-catalog)', () => {
  let publisher: DKGAgent;
  let curator: string;

  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8553);
    await setMinimumRequiredSignatures(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, 1);

    // Genesis core nodes are pre-staked. Publisher = CORE_OP (curator/member);
    // the connected REC1 core holds the curated ciphertext and supplies the ACK.
    publisher = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(), name: 'CatPublisher', nodeRole: 'core', listenPort: 0, skills: [],
      dataDir: mkDataDir('pub'),
      chainConfig: chainConfig(HARDHAT_KEYS.CORE_OP, HARDHAT_KEYS.CORE_ADMIN),
    });
    const ackCore = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(), name: 'CatAckCore', nodeRole: 'core', listenPort: 0, skills: [],
      dataDir: mkDataDir('ack'),
      chainConfig: chainConfig(HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC1_ADMIN),
    });
    agents.push(publisher, ackCore);
    await publisher.start(); await ackCore.start();
    await ackCore.connectTo(publisher.multiaddrs[0]);
    await new Promise((r) => setTimeout(r, 2000));
    curator = publisher.defaultAgentAddress ?? publisher.peerId;
  }, 180_000);

  afterAll(async () => {
    for (const a of agents) { try { await a.stop(); } catch {} }
    killHardhat(ctx);
  });

  it('a private CG publishes via the product path and yields exactly N data KAs', async () => {
    const CG = 'rfc49-baseline-private';
    await publisher.createContextGraph({ id: CG, name: 'RFC49 Baseline Private', accessPolicy: 1, callerAgentAddress: curator });
    await publisher.registerContextGraph(CG, { callerAgentAddress: curator });

    const name = 'shipment';
    await publisher.assertion.create(CG, name);
    await publisher.assertion.write(CG, name, [
      { subject: 'urn:acme:shipment/SH-42', predicate: 'urn:acme:product', object: '"P-9"' },
    ]);
    // Explicit finalize = the daemon product path (POST /vm/publish does
    // assertion.finalize then publishFromFinalizedAssertion). The catalog
    // injection lives in assertionFinalize; promote then carries the sealed
    // content (incl. the catalog KA) to SWM for reload.
    await publisher.assertion.finalize(CG, name);
    await publisher.assertion.promote(CG, name);

    const pub: any = await publisher.publishFromFinalizedAssertion(CG, name);

    expect(pub.status).toBe('confirmed');
    // OT-RFC-49 combined model: the private publish now carries the data KA AND
    // the public DCAT catalog KA (subject = the CG's own UAL), committed in the
    // CG's own merkle root.
    expect(pub.kaManifest.length).toBe(2);
    const roots = pub.kaManifest.map((m: any) => String(m.rootEntity ?? m.entity ?? m.subject ?? ''));
    expect(roots.some((r: string) => r.includes(CG))).toBe(true); // the catalog KA, keyed on the CG UAL
  });
});
