// SPDX-License-Identifier: Apache-2.0
/**
 * Confirmed lifecycle repair against a live Blazegraph that is killed and restarted.
 *
 * The agent applies confirmed VM lifecycle metadata through a real BlazegraphStore with
 * its default restart-durable commitment and retires its repair journal. The Blazegraph
 * container is then killed (SIGKILL, so no shutdown hook runs) and started again, and the
 * descriptor must still be there. A kill keeps the host page cache, so this shows that
 * Blazegraph acknowledged the writes only after committing them to its journal and that
 * the journal recovers after abrupt process death. It cannot show that a commit was
 * forced to disk.
 *
 * It needs BLAZEGRAPH_TEST_URL and a container it may restart: the one named by
 * BLAZEGRAPH_TEST_RESTART_CONTAINER, or else the single running container that publishes
 * the URL's loopback host port. Without one it skips with the reason, or fails when
 * DKG_REQUIRE_BLAZEGRAPH_RESTART=1. It always leaves a killed server serving again.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ethers } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertionLifecycleUri, buildAssertionSealQuads, contextGraphAssertionUri, contextGraphMetaUri,
  parseAssertionSealQuads } from '@origintrail-official/dkg-core';
import { BlazegraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { decodeLifecycleRepairJournal } from '../src/named-ka-vm-lifecycle-repair-journal.js';

const ENDPOINT = process.env.BLAZEGRAPH_TEST_URL;
const READY_TIMEOUT_MS = 120_000;
const AUTHOR = '0x1111111111111111111111111111111111111111';
const CG = `confirmed-lifecycle-restart-${randomUUID()}`, NAME = 'restart-asset';
const UAL = `did:dkg:mock:31337/${AUTHOR}/1`, PACKED = (BigInt(AUTHOR) << 96n) | 1n;
const PUBLISHED = 'did:dkg:mock:31337/0x2222222222222222222222222222222222222222/1';
const DKG = 'http://dkg.io/ontology/', ROOT = `0x${'cd'.repeat(32)}`, PRIOR = 'ab'.repeat(32);
const META = contextGraphMetaUri(CG), LIFECYCLE = assertionLifecycleUri(CG, AUTHOR, NAME);
const ASSERTION = contextGraphAssertionUri(CG, AUTHOR, NAME);
/** The shared SWM state a confirmed publication left before its lifecycle stamp. */
const SHARED: Quad[] = [
  { subject: LIFECYCLE, predicate: `${DKG}vmCurrentAssertion`, object: JSON.stringify(PRIOR), graph: META },
  { subject: LIFECYCLE, predicate: `${DKG}wmCurrentAssertion`, object: JSON.stringify(ROOT.slice(2)), graph: META },
  { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"shared"', graph: META },
  { subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
  { subject: ASSERTION, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
];
const DESCRIPTOR = `ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "published" ; <${DKG}memoryLayer> "VM" ;
  <${DKG}vmCurrentAssertion> "${ROOT.slice(2)}" ; <${DKG}publishedUal> ${JSON.stringify(PUBLISHED)} } }`;

type RestartControl = { container: string; statusUrl: string };
const run = promisify(execFile);
const docker = (args: string[]) => run('docker', args, { timeout: 60_000, encoding: 'utf8' });
const reason = (error: unknown) => (error as { stderr?: string }).stderr?.trim()
  || (error instanceof Error ? error.message : String(error));

/** Choose the container this test may kill, or say why there is none. */
async function restartControl(): Promise<RestartControl | { skip: string }> {
  if (!ENDPOINT) return { skip: 'BLAZEGRAPH_TEST_URL is not set' };
  const url = new URL(ENDPOINT);
  const statusUrl = new URL(url.pathname.replace(/(?:\/namespace\/[^/]+)?\/sparql\/?$/, '/status'), url).href;
  const named = process.env.BLAZEGRAPH_TEST_RESTART_CONTAINER?.trim();
  if (named) {
    try { await docker(['inspect', '--format', '{{.Id}}', named]); } catch (error) {
      return { skip: `cannot inspect container ${named}: ${reason(error)}` };
    }
    return { container: named, statusUrl };
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return { skip: `${url.host} is not a loopback endpoint; name its container in BLAZEGRAPH_TEST_RESTART_CONTAINER` };
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  let listing: string;
  try { listing = (await docker(['ps', '--format', '{{.ID}} {{.Ports}}'])).stdout; } catch (error) {
    return { skip: `Docker cannot list containers: ${reason(error)}` };
  }
  // `docker ps --filter publish=` matches the container-side port, so match the host side.
  const matches = listing.split('\n').filter(line => line.includes(`:${port}->`)).map(line => line.split(' ')[0]!);
  return matches.length === 1 ? { container: matches[0]!, statusUrl }
    : { skip: `expected one running container publishing host port ${port}, found ${matches.length}` };
}

async function serving(statusUrl: string, endpoint: string): Promise<boolean> {
  try {
    if (!(await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) })).ok) return false;
    return (await fetch(endpoint, { method: 'POST', body: 'ASK { ?s ?p ?o }', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/sparql-query', Accept: 'application/sparql-results+json' } })).ok;
  } catch { return false; }
}

/** Idempotent: start the container if it is down, then wait for status and a namespace query. */
async function ensureServing(control: RestartControl, endpoint: string): Promise<void> {
  await docker(['start', control.container]);
  for (const deadline = Date.now() + READY_TIMEOUT_MS; Date.now() < deadline;) {
    if (await serving(control.statusUrl, endpoint)) return;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Blazegraph container ${control.container} did not serve ${control.statusUrl} within ${READY_TIMEOUT_MS}ms`);
}

/** The repair path reads only these members of an agent. */
function repairHost(store: BlazegraphStore, dataDir: string, warnings: string[]): DKGAgent {
  const host = Object.create(DKGAgent.prototype) as Record<string, unknown>;
  Object.assign(host, {
    config: { dataDir }, store, writeLocks: new Map<string, Promise<void>>(),
    log: { warn: (_context: unknown, message: string) => { warnings.push(message); }, info() {}, debug() {}, error() {} },
    chain: {
      getEvmChainId: async () => 31337n,
      getKnowledgeAssetsLifecycleAddress: async () => AUTHOR,
      readKnowledgeAssetVersionSnapshot: async () => ({ latestRoot: ROOT, rootCount: 1n }),
    },
  });
  return host as unknown as DKGAgent;
}

function confirmedPublication() {
  const seal = parseAssertionSealQuads(buildAssertionSealQuads({ assertionUri: ASSERTION, metaGraph: META,
    merkleRoot: ethers.getBytes(ROOT), authorAddress: AUTHOR, authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2), authorSchemeVersion: 1, chainId: 31337n, kav10Address: AUTHOR,
    reservedKaId: PACKED, finalizedAtIso: new Date().toISOString(), contentScopeVersion: 2,
    kaUal: UAL, assertionVersion: 1, publicTripleCount: 1, privateTripleCount: 0 }), ASSERTION);
  if (!seal) throw new Error('Expected a parsed assertion seal');
  return { status: 'confirmed' as const, ual: PUBLISHED, kaId: PACKED, merkleRoot: seal.merkleRoot,
    kaManifest: [], assertionUri: ASSERTION, seal };
}

describe('confirmed lifecycle repair across an abrupt Blazegraph restart (live)', () => {
  let control: RestartControl | { skip: string } = { skip: 'restart control was not resolved' };
  let dataDir: string | undefined, seeded = false, killed = false;

  beforeAll(async () => { control = await restartControl(); }, 90_000);

  afterAll(async () => {
    // Vitest does not wait for a timed-out test's finally; never leave the job's server down.
    if (killed && ENDPOINT && 'container' in control) await ensureServing(control, ENDPOINT);
    if (seeded && ENDPOINT) {
      const store = new BlazegraphStore(ENDPOINT);
      try { await store.dropGraph(META); } finally { await store.close(); }
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, READY_TIMEOUT_MS + 30_000);

  it('keeps the confirmed descriptor after its journal retires and Blazegraph is killed and restarted', async ctx => {
    if ('skip' in control) {
      if (process.env.DKG_REQUIRE_BLAZEGRAPH_RESTART === '1') throw new Error(`Blazegraph restart check required: ${control.skip}`);
      console.warn(`[confirmed-lifecycle-restart] SKIPPED: ${control.skip}`);
      return ctx.skip(control.skip);
    }
    const target = control, endpoint = ENDPOINT!;
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-blazegraph-restart-'));
    const store = new BlazegraphStore(endpoint), warnings: string[] = [];
    try {
      expect(store.commitment?.durability).toBe('restart-durable');
      seeded = true; await store.insert(SHARED);
      const agent = repairHost(store, dataDir, warnings);
      try {
        const pending = await agent._repairConfirmedNamedKaVmLifecycle(
          { contextGraphId: CG, agentAddress: AUTHOR, name: NAME, packedKaId: PACKED }, confirmedPublication());
        expect(pending, warnings.join('\n')).toBe(false);
      } finally { await agent.getOrCreateNamedKaVmLifecycleRepair().stop(); }
      const journal = JSON.parse(await readFile(join(dataDir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
      expect(decodeLifecycleRepairJournal(journal).size).toBe(0); // The certified apply retired the durable record.
      expect(await store.query(DESCRIPTOR)).toMatchObject({ value: true });
    } finally { await store.close(); }

    killed = true;
    try {
      await docker(['kill', target.container]);
      expect((await docker(['wait', target.container])).stdout.trim()).toBe('137'); // 128 + SIGKILL
    } finally {
      // Serve again before anything else can fail, so later suites in the job find it ready.
      await ensureServing(target, endpoint);
      killed = false;
    }
    const restarted = new BlazegraphStore(endpoint);
    try { expect(await restarted.query(DESCRIPTOR)).toMatchObject({ value: true }); } finally { await restarted.close(); }
  }, 2 * READY_TIMEOUT_MS + 60_000);
});
