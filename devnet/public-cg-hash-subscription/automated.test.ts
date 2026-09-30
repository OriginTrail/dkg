/**
 * Public Context Graph subscribed by its on-chain name hash - devnet coverage.
 *
 * Network-observable behavior under test (real Hardhat chain, real libp2p, real
 * daemons and stores; no mocks):
 *
 *   1. A public Context Graph registered on the real ContextGraphs contract
 *      commits `nameHash = keccak256(utf8(id))`; the cleartext id is never
 *      on-chain.
 *   2. An edge that subscribes with only that hash (`POST /api/context-graph/
 *      subscribe { contextGraphId: <nameHash> }`) is moved to the cleartext id
 *      once a peer reveals it and the edge verifies the keccak commitment, and
 *      then converges on both the shared working memory and the finalized
 *      verifiable memory the author published BEFORE the edge subscribed. Before
 *      the fix for the dead zone (#2744) the subscription synced 0 quads.
 *   3. The catch-up job the subscribe minted is reachable by its job id, by the
 *      cleartext id and by the on-chain id (and by the hash when the job was
 *      created under it, #2779), and an on-chain numeric id (`#<n>`) subscribes
 *      the same graph (#2758).
 *   4. A graph registered on chain whose cleartext no peer holds stays hash-only:
 *      no cleartext row is invented, and its catch-up settles as `unreachable`
 *      with the name-hash-only note rather than as a retryable failure.
 *
 * Preconditions:
 *   pnpm run build:packages && pnpm --dir packages/cli run build:prepared
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Node 1 is a core and the author. Nodes 5 and 6 are edges: they only ever read.
 * The suite mutates only the Context Graphs it creates itself (ISOLATION
 * INVARIANT in devnet/_bootstrap/harness.ts). The hash-only scenario runs last,
 * on the edge that has already finished its positive scenario.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  contractAt,
  detectDevnet,
  ensureAllIdentities,
  fundTrac,
  getJson,
  makeNquadsFile,
  nextNonce,
  normTerm,
  postJson,
  publishViaCli,
  queryNode,
  runDkgCli,
  setEth,
  sleep,
  waitFor,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';

const NAME_PREDICATE = 'https://schema.org/name';
const keccak = (id: string): string => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
const STAMP = Date.now().toString(36);

interface IdentityNote {
  state: string;
  nameHash?: string;
  onChainId?: string;
  contextGraphId?: string;
  message?: string;
}

interface SubscriptionRow {
  contextGraphId: string;
  subscribed: boolean;
  synced: boolean;
  coreHosted: boolean;
  identity?: IdentityNote;
}

interface SubscribeResponse {
  subscribed: string;
  syncMode?: string;
  catchup?: { status: string; jobId: string };
  identity?: IdentityNote;
  onChainReference?: { onChainId: string };
}

interface CatchupStatus {
  jobId: string;
  contextGraphId: string;
  status: string;
  jobStatus: string;
  error?: string;
  resolvedContextGraphId?: string;
  identity?: IdentityNote;
}

interface PublishedGraph {
  id: string;
  onChainId: string;
  nameHash: string;
  /** Shared to SWM only: the edge must backfill it from a peer. */
  swm: { subject: string; value: string };
  /** Published to VM on chain: the edge must fetch it from a holder. */
  vm: { subject: string; value: string };
}

let state: DevnetState;
let author: DevnetNode;
let edgeA: DevnetNode;
let edgeB: DevnetNode;
let graph: PublishedGraph;

const CG_FACADE_ABI = [
  'function createContextGraph(address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId, bytes32 nameHash) returns (uint256)',
  'function contextGraphStorage() view returns (address)',
];
const CG_STORAGE_ABI = [
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'event ContextGraphCreated(uint256 indexed contextGraphId, address indexed owner, bytes32 indexed nameHash, address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
];
const PARAMS_ABI = ['function contextGraphRegistrationDeposit() view returns (uint96)'];
const TOKEN_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];

/** ContextGraphStorage is reached through the ContextGraphs facade, not the Hub's contract table. */
async function contextGraphStorage(): Promise<ethers.Contract> {
  const facade = contractAt(state, 'ContextGraphs', CG_FACADE_ABI);
  return new ethers.Contract(await facade.contextGraphStorage(), CG_STORAGE_ABI, state.provider);
}

async function listSubscriptions(node: DevnetNode): Promise<SubscriptionRow[]> {
  const res = await getJson(node, '/api/context-graph/subscriptions');
  expect(res.status, `node${node.num} GET /api/context-graph/subscriptions: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json.subscriptions as SubscriptionRow[];
}

/**
 * Subscribe, retrying only while the node has not yet read the graph from the
 * chain (a retryable 503, or a numeric id the node has not seen yet: 404).
 */
async function subscribeWhenAdmitted(node: DevnetNode, contextGraphId: string): Promise<SubscribeResponse> {
  let last = '';
  return waitFor(`node${node.num} subscribes ${contextGraphId}`, 120_000, 3_000, async () => {
    const res = await postJson(node, '/api/context-graph/subscribe', {
      contextGraphId,
      includeSharedMemory: true,
      syncMode: 'always-on',
    });
    if (res.status === 200) return res.json as SubscribeResponse;
    last = `${res.status} ${JSON.stringify(res.json)}`;
    if (res.status === 503 || res.status === 404) return null;
    throw new Error(`node${node.num} subscribe ${contextGraphId} refused: ${last}`);
  }).catch((err: unknown) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)} (last response: ${last})`);
  });
}

/**
 * Wait until the node has observed the graph's slot on chain (its own chain
 * poller staged a row for it): only then does a name-hash subscribe find the
 * hash-keyed row it promotes.
 */
async function waitUntilChainSlotObserved(node: DevnetNode, onChainId: string): Promise<void> {
  await waitFor(`node${node.num} observes on-chain slot ${onChainId}`, 120_000, 3_000, async () => {
    const res = await getJson(node, '/api/context-graph/list');
    if (res.status !== 200) return null;
    const rows = (res.json?.contextGraphs ?? []) as Array<{ onChainId?: unknown; onChain?: { id?: unknown } }>;
    return rows.some((row) => String(row.onChainId ?? row.onChain?.id ?? '') === onChainId) ? true : null;
  });
}

async function catchupStatus(node: DevnetNode, contextGraphId: string): Promise<CatchupStatus | null> {
  const res = await getJson(node, `/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`);
  return res.status === 200 ? (res.json as CatchupStatus) : null;
}

type View = 'shared-working-memory' | 'verifiable-memory';

/** Every (predicate, object) of one subject in one memory view, as a sorted list. */
async function subjectContent(node: DevnetNode, contextGraphId: string, subject: string, view: View): Promise<string[]> {
  const rows = await queryNode(node, `SELECT ?p ?o WHERE { <${subject}> ?p ?o }`, { contextGraphId, view });
  return rows.map((row) => `${normTerm(row.p)} ${normTerm(row.o)}`).sort();
}

/** The same read, tolerating a node that does not know the graph at all yet. */
async function tryRowCount(node: DevnetNode, contextGraphId: string, subject: string, view: View): Promise<number> {
  const res = await postJson(node, '/api/query', {
    sparql: `SELECT ?o WHERE { <${subject}> <${NAME_PREDICATE}> ?o }`,
    contextGraphId,
    view,
  });
  if (res.status !== 200) return 0;
  const bindings = res.json?.result?.bindings ?? res.json?.results?.bindings ?? res.json?.bindings ?? [];
  return Array.isArray(bindings) ? bindings.length : 0;
}

/**
 * Wait for a subject's content to match the author's on an edge.
 *
 * The first catch-up job of a subscription can be cut short by a transient
 * authority failure (an RFC-64 authority RPC circuit that is open for a while
 * after chain reads time out on a loaded machine): the job then ends `failed`
 * and nothing retries it by itself. An operator recovers with a fresh subscribe
 * and `forceCatchup`, so this helper does the same once a minute, and reports
 * the last job's verdict if the content never arrives.
 */
async function waitForContent(
  node: DevnetNode,
  contextGraphId: string,
  subject: string,
  view: View,
  expected: string[],
  label: string,
  budgetMs = 420_000,
): Promise<void> {
  let lastRetryAt = Date.now();
  try {
    await waitFor(`${label}: node${node.num} ${view} content of ${subject}`, budgetMs, 3_000, async () => {
      const rows = await subjectContent(node, contextGraphId, subject, view).catch(() => [] as string[]);
      if (rows.length > 0 && JSON.stringify(rows) === JSON.stringify(expected)) return rows;
      if (Date.now() - lastRetryAt >= 60_000) {
        lastRetryAt = Date.now();
        await postJson(node, '/api/context-graph/subscribe', {
          contextGraphId,
          includeSharedMemory: true,
          syncMode: 'always-on',
          forceCatchup: true,
        }).catch(() => undefined);
      }
      return null;
    });
  } catch (err) {
    const job = await catchupStatus(node, contextGraphId).catch(() => null);
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} (last catch-up job: ${job?.jobStatus ?? 'none'}`
      + `${job?.error ? `, ${job.error}` : ''})`,
    );
  }
}

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error('Live 6-node devnet not detected. Run ./scripts/devnet.sh start 6 first.');
  }
  state = detected;
  author = state.nodes[1]!;
  edgeA = state.nodes[5]!;
  edgeB = state.nodes[6]!;
  await ensureAllIdentities(state, 4);
  expect(author.identityId, 'core node1 must have a registered identity').toBeGreaterThan(0n);
}, 240_000);

describe('public Context Graph subscribed by on-chain name hash on devnet', () => {
  it('registers a public graph on the real chain, which commits only keccak256 of its id, and publishes SWM + VM', async () => {
    const id = `devnet-hash-sub-${STAMP}`;
    const created = await postJson(author, '/api/context-graph/create', {
      id,
      name: `Hash subscription ${STAMP}`,
      description: 'devnet coverage for subscribing by on-chain name hash',
      accessPolicy: 0,
      publishPolicy: 1,
      register: true,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json.registered, JSON.stringify(created.json)).toBe(true);
    const onChainId = String(created.json.onChainId);
    expect(BigInt(onChainId)).toBeGreaterThan(0n);

    // The contract commits exactly the preimage's keccak: the property every
    // verifying edge relies on.
    const storage = await contextGraphStorage();
    expect(String(await storage.getNameHash(BigInt(onChainId))).toLowerCase()).toBe(keccak(id));

    // KA 1: shared to SWM only. KA 2: shared, then published to VM on chain.
    const swm = makeNquadsFile(import.meta.dirname, 'hashsub-swm', id);
    const shared = await runDkgCli(author, [
      'ka', 'create', `hashsub-swm-${STAMP}`,
      '--context-graph-id', id,
      '--input-file', swm.path,
      '--share',
    ], 120_000);
    expect(shared.code, `ka create --share failed\n${shared.stdout}\n${shared.stderr}`).toBe(0);
    const vm = makeNquadsFile(import.meta.dirname, 'hashsub-vm', id);
    const published = await publishViaCli(author, id, vm.path);
    expect(published.status).toBe('confirmed');

    graph = {
      id,
      onChainId,
      nameHash: keccak(id),
      swm: { subject: swm.subject, value: 'hashsub-swm' },
      vm: { subject: vm.subject, value: 'hashsub-vm' },
    };
    // The author holds both (store materialization can lag the CLI's return).
    for (const [view, subject] of [
      ['shared-working-memory', graph.swm.subject],
      ['verifiable-memory', graph.vm.subject],
    ] as const) {
      await waitFor(`author ${view} content of ${subject}`, 120_000, 3_000, async () => {
        const rows = await subjectContent(author, id, subject, view).catch(() => [] as string[]);
        return rows.length > 0 ? rows : null;
      });
    }
  }, 900_000);

  it('an edge subscribed by name hash alone adopts the verified cleartext id and converges on SWM and VM', async () => {
    // The edge knows nothing of the graph but what the chain says.
    const before = await listSubscriptions(edgeA);
    expect(before.map((row) => row.contextGraphId)).not.toContain(graph.id);
    expect(await tryRowCount(edgeA, graph.id, graph.swm.subject, 'shared-working-memory')).toBe(0);
    expect(await tryRowCount(edgeA, graph.id, graph.vm.subject, 'verifiable-memory')).toBe(0);

    await waitUntilChainSlotObserved(edgeA, graph.onChainId);
    const subscribed = await subscribeWhenAdmitted(edgeA, graph.nameHash);
    // The route reports the id it subscribed: the cleartext one when a peer
    // revealed it within the request, else the hash (which the resolver then
    // promotes in the background).
    expect([graph.id, graph.nameHash]).toContain(subscribed.subscribed);
    // eslint-disable-next-line no-console
    console.log(`hash-sub: subscribe by hash answered with subscribed=${subscribed.subscribed} identity=${JSON.stringify(subscribed.identity ?? null)}`);

    // Wait for the promotion: a row keyed by the cleartext id, none by the hash.
    const row = await waitFor(`node${edgeA.num} adopts ${graph.id}`, 180_000, 3_000, async () => {
      const rows = await listSubscriptions(edgeA);
      const adopted = rows.find((candidate) => candidate.contextGraphId === graph.id && candidate.subscribed);
      return adopted !== undefined && !rows.some((candidate) => candidate.contextGraphId === graph.nameHash)
        ? adopted
        : null;
    });
    expect(keccak(row.contextGraphId), 'the adopted id is the preimage of the on-chain hash').toBe(graph.nameHash);
    expect(row.identity, 'a resolved row carries no name-hash-only note').toBeUndefined();

    // What the hash could never reach: the SWM copy published before the edge
    // subscribed, and the finalized VM copy, each byte-identical to the author's.
    const swmExpected = await subjectContent(author, graph.id, graph.swm.subject, 'shared-working-memory');
    const vmExpected = await subjectContent(author, graph.id, graph.vm.subject, 'verifiable-memory');
    await waitForContent(edgeA, graph.id, graph.vm.subject, 'verifiable-memory', vmExpected, 'name-hash subscribe');
    await waitForContent(edgeA, graph.id, graph.swm.subject, 'shared-working-memory', swmExpected, 'name-hash subscribe');
    expect(swmExpected.some((entry) => entry.includes(graph.swm.value))).toBe(true);
    expect(vmExpected.some((entry) => entry.includes(graph.vm.value))).toBe(true);

    // The catch-up job the subscribe minted is reachable by its id, by the
    // cleartext id and by the on-chain id, and always names the cleartext graph.
    const jobId = subscribed.catchup?.jobId;
    expect(jobId, JSON.stringify(subscribed)).toEqual(expect.any(String));
    const byJobId = await getJson(edgeA, `/api/sync/catchup-status?jobId=${encodeURIComponent(jobId!)}`);
    expect(byJobId.status, JSON.stringify(byJobId.json)).toBe(200);
    expect((byJobId.json as CatchupStatus).resolvedContextGraphId ?? (byJobId.json as CatchupStatus).contextGraphId).toBe(graph.id);
    const byCleartextId = await catchupStatus(edgeA, graph.id);
    expect(byCleartextId?.jobId).toBe(jobId);
    const byOnChainId = await catchupStatus(edgeA, graph.onChainId);
    expect(byOnChainId?.jobId).toBe(jobId);
    // Looked up by the hash it was subscribed with (#2779), a job created under
    // the hash names the cleartext graph once it resolved. When the subscribe
    // request itself resolved the hash (the usual case with a connected holder)
    // the job is keyed by the cleartext id only and a lookup by the hash finds
    // no job: reported with this PR, not asserted here.
    if (subscribed.subscribed === graph.nameHash) {
      const byHash = await waitFor(`node${edgeA.num} catch-up status by name hash`, 60_000, 2_000, async () => catchupStatus(edgeA, graph.nameHash));
      expect(byHash.resolvedContextGraphId ?? byHash.contextGraphId).toBe(graph.id);
      if (byHash.identity) {
        expect(byHash.identity).toMatchObject({ state: 'resolved', nameHash: graph.nameHash, contextGraphId: graph.id });
      }
    }
  }, 900_000);

  it('a second edge subscribed by numeric on-chain id lands on the same cleartext graph (#2758)', async () => {
    await waitUntilChainSlotObserved(edgeB, graph.onChainId);
    const subscribed = await subscribeWhenAdmitted(edgeB, `#${graph.onChainId}`);
    expect(subscribed.onChainReference, JSON.stringify(subscribed)).toMatchObject({ onChainId: graph.onChainId });
    // The numeric id names the same slot; the row is never keyed by the number.
    await waitFor(`node${edgeB.num} adopts ${graph.id}`, 180_000, 3_000, async () => {
      const rows = await listSubscriptions(edgeB);
      const adopted = rows.some((candidate) => candidate.contextGraphId === graph.id && candidate.subscribed);
      return adopted && !rows.some((candidate) => candidate.contextGraphId === graph.nameHash) ? true : null;
    });
    expect((await listSubscriptions(edgeB)).map((row) => row.contextGraphId)).not.toContain(graph.onChainId);

    const swmExpected = await subjectContent(author, graph.id, graph.swm.subject, 'shared-working-memory');
    const vmExpected = await subjectContent(author, graph.id, graph.vm.subject, 'verifiable-memory');
    await waitForContent(edgeB, graph.id, graph.vm.subject, 'verifiable-memory', vmExpected, 'numeric-id subscribe');
    await waitForContent(edgeB, graph.id, graph.swm.subject, 'shared-working-memory', swmExpected, 'numeric-id subscribe');
  }, 900_000);

  it('a graph registered on chain whose cleartext no peer holds stays hash-only: nothing is invented', async () => {
    // Registered straight on the real ContextGraphs contract by a throwaway
    // wallet, with a name commitment whose preimage no node has ever seen.
    const nameHash = keccak(`devnet-nobody-holds-this-name/${STAMP}`);
    const wallet = ethers.Wallet.createRandom().connect(state.provider);
    await setEth(state, wallet.address, '100');
    await fundTrac(state, wallet.address, ethers.parseEther('100000'));
    const facade = state.addrs.ContextGraphs;
    expect(facade, 'ContextGraphs must be registered in the Hub').toBeTruthy();
    const deposit: bigint = await contractAt(state, 'ParametersStorage', PARAMS_ABI).contextGraphRegistrationDeposit();
    if (deposit > 0n) {
      const token = new ethers.Contract(state.addrs.Token!, TOKEN_ABI, wallet);
      await (await token.approve(facade, deposit, { nonce: await nextNonce(state.provider, wallet.address) })).wait();
    }
    const contextGraphs = new ethers.Contract(facade!, CG_FACADE_ABI, wallet);
    const receipt = await (await contextGraphs.createContextGraph(
      [], 0n, 0, 1, ethers.ZeroAddress, 0n, nameHash,
      { nonce: await nextNonce(state.provider, wallet.address) },
    )).wait();
    const storageIface = new ethers.Interface(CG_STORAGE_ABI);
    let onChainId = '';
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = storageIface.parseLog(log);
        if (parsed?.name === 'ContextGraphCreated') onChainId = String(parsed.args.contextGraphId);
      } catch { /* another contract's event */ }
    }
    expect(onChainId, 'ContextGraphCreated must be in the receipt').not.toBe('');

    await waitUntilChainSlotObserved(edgeB, onChainId);
    const before = (await listSubscriptions(edgeB)).map((row) => row.contextGraphId);
    const subscribed = await subscribeWhenAdmitted(edgeB, nameHash);
    expect(subscribed.subscribed).toBe(nameHash);
    expect(subscribed.identity, JSON.stringify(subscribed)).toMatchObject({ state: 'name-hash-only', nameHash, onChainId });

    // Give the resolver several rounds against every connected peer; it must
    // still find nothing, and must not have made up an id.
    await sleep(30_000);
    const after = await listSubscriptions(edgeB);
    const row = after.find((candidate) => candidate.contextGraphId === nameHash);
    expect(row, 'the hash-keyed row stays').toBeDefined();
    expect(row!.subscribed).toBe(true);
    expect(row!.identity).toMatchObject({ state: 'name-hash-only', nameHash, onChainId });
    const added = after.map((candidate) => candidate.contextGraphId).filter((id) => !before.includes(id));
    expect(added, 'no other row appeared for the unknown graph').toEqual([nameHash]);

    // Catch-up cannot succeed under a name nobody holds; it says so instead of asking for a retry.
    const status = await waitFor(`node${edgeB.num} catch-up settles for the hash-only graph`, 120_000, 3_000, async () => {
      const found = await catchupStatus(edgeB, nameHash);
      return found !== null && found.jobStatus !== 'queued' && found.jobStatus !== 'running' ? found : null;
    });
    expect(status.jobStatus).toBe('unreachable');
    expect(status.identity).toMatchObject({ state: 'name-hash-only', nameHash, onChainId });
    // The verdict is the name-hash-only note, not the generic "no peer could deliver" one.
    expect(status.error).toBe(status.identity?.message);
    expect(status.error).toContain('on-chain name hash');
  }, 900_000);
});
