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
 *      then converges on the finalized verifiable memory the author published
 *      BEFORE the edge subscribed (before the fix for the dead zone, #2744, the
 *      subscription synced 0 quads).
 *   3. The catch-up job the subscribe minted is reachable by its job id, by the
 *      cleartext id and by the on-chain id, and an on-chain numeric id (`#<n>`)
 *      subscribes the same graph (#2758). The by-hash lookup (#2779) is asserted
 *      only when the job was created under the hash; when the subscribe request
 *      itself resolved the hash (the usual case here) the job is keyed by the
 *      cleartext id and a lookup by the hash finds none, so that branch is not
 *      exercised by this suite. The content waits only read: they never
 *      re-subscribe, so the job a test started stays the latest one.
 *   4. A forced catch-up (`forceCatchup`, the operator's recovery) on an already
 *      converged graph mints a replacement job that both aliases follow; the
 *      superseded job stays readable by its id and the content is unchanged.
 *   5. The shared working memory of the shared-only graph (shared but never
 *      published) backfills on both edges after they subscribe by hash and by
 *      numeric id.
 *      It is its own graph and its own test because holders serve SWM only once
 *      their RFC-64 authority pipeline has accepted the graph, and that pipeline
 *      can lag for many minutes after a devnet starts; the adoption and VM tests
 *      above do not depend on it. It is the one scenario that recovers
 *      explicitly (a forced catch-up once a minute), and afterwards it expects
 *      the aliases to name whichever job is latest.
 *   6. A graph registered on chain whose cleartext no peer holds stays hash-only:
 *      no cleartext row is invented, and its catch-up settles as `unreachable`
 *      with the name-hash-only note rather than as a retryable failure.
 *
 * Structure: every test runs correctly alone or after any other test.
 *
 *   - FIXTURE (`beforeAll`): the graphs are created once, before any test, and
 *     never change afterwards (`Fixture`: ids, on-chain ids, name hashes,
 *     subjects, values). The expensive devnet detection and identity setup is
 *     shared the same way. Creation is not a test and no test creates a graph.
 *   - ARRANGE (inside each test): the edge state a test needs is made by that
 *     test. No (edge, graph) pair is used by two tests:
 *
 *         test 2  edge A          vm graph      subscribed by name hash
 *         test 3  edge B          vm graph      subscribed by numeric id
 *         test 4  edge A          forced graph  arranged converged, then forced
 *         test 5  edge A, edge B  swm graph     subscribed by hash / numeric id
 *         test 6  edge B          unheld name   subscribed by hash
 *
 *     Tests 2, 3, 5 and 6 have a subscribe as their subject, so they need an edge
 *     with no subscribed row for the graph and check that (`expectNoRowFor`)
 *     instead of silently asserting on someone else's leftovers. (The edge's chain
 *     poller may already know the slot: that is not a subscription.) Test 4 is the only one that
 *     needs a state a subscribe leaves behind (an edge converged on VM), so it
 *     makes it itself with the idempotent `ensureConverged` (subscribe only when
 *     the edge has no row, then wait for adoption and content). It does that on a
 *     graph of its own rather than the vm graph: borrowing test 2's edge and
 *     graph would consume test 2's "never seen" precondition whenever test 4 ran
 *     first. Keeping it a separate test (instead of a late phase of test 2) keeps
 *     a failure attributable and lets it run by name.
 *
 * Run one test alone with a name filter, for example
 *   pnpm exec vitest run --config devnet/public-cg-hash-subscription/vitest.config.ts -t "forced catch-up mints"
 * (the fixture is still created first, as it is for every run).
 *
 * Preconditions:
 *   pnpm run build:packages && pnpm --dir packages/cli run build:prepared
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Node 1 is a core and the author. Nodes 5 and 6 are edges: they only ever read.
 * The suite mutates only the Context Graphs it creates itself (ISOLATION
 * INVARIANT in devnet/_bootstrap/harness.ts).
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
// The daemon's own wire declarations, type-only: nothing under packages/ loads at
// runtime, and a renamed or retyped field fails the type-check instead of a long
// devnet run (repo practice: devnet/ack-candidate-isolation imports the cli source).
import type { ApiClient } from '../../packages/cli/src/api-client.js';
import type {
  CatchupContextGraphIdentity,
  CatchupJobState,
  CatchupStatusResponse,
} from '../../packages/cli/src/catchup-status.js';

const NAME_PREDICATE = 'https://schema.org/name';
const keccak = (id: string): string => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
const STAMP = Date.now().toString(36);

/**
 * Response of POST /api/context-graph/subscribe: the CLI client's declaration of
 * it (`ApiClient.subscribeToContextGraph`), which carries the `identity` and
 * `onChainReference` notes. The route builds the body inline and exports no type
 * of its own.
 */
type SubscribeResponse = Awaited<ReturnType<ApiClient['subscribeToContextGraph']>>;

/** Response of GET /api/context-graph/list (`ApiClient.listContextGraphs`). */
type ContextGraphListResponse = Awaited<ReturnType<ApiClient['listContextGraphs']>>;

/**
 * One row of GET /api/context-graph/subscriptions. The route builds it inline
 * (packages/cli/src/daemon/routes/context-graph.ts, "GET /api/context-graph/
 * subscriptions") and no exported declaration exists, so the four scalar fields
 * are stated here exactly as the route emits them; `identity` is the daemon's
 * name-hash identity note, the same declaration the subscribe reply and the
 * catch-up status carry.
 */
interface SubscriptionRow {
  contextGraphId: string;
  subscribed: boolean;
  synced: boolean;
  coreHosted: boolean;
  identity?: CatchupContextGraphIdentity;
}

/** A public graph registered on chain, holding one Knowledge Asset by one subject. */
interface RegisteredGraph {
  readonly id: string;
  readonly onChainId: string;
  readonly nameHash: string;
  readonly subject: string;
  readonly value: string;
}

/** A graph registered on chain straight through the contract, whose preimage no node has ever seen. */
interface UnheldGraph {
  readonly nameHash: string;
  readonly onChainId: string;
}

/** Everything the tests share. Built once in `beforeAll`, never modified afterwards. */
interface Fixture {
  /** Its Knowledge Asset is published to VM on chain: edges must fetch it from a holder (tests 2 and 3). */
  readonly vm: RegisteredGraph;
  /** Same shape as `vm`, kept for the forced catch-up test alone (test 4). */
  readonly forced: RegisteredGraph;
  /** Its Knowledge Asset is only shared to SWM: edges must backfill it from a peer (test 5). */
  readonly swm: RegisteredGraph;
  /** Registered on chain with a name commitment nobody can resolve (test 6). */
  readonly unheld: UnheldGraph;
}

// The devnet handles, found once in `beforeAll` and never reassigned.
let state: DevnetState;
let author: DevnetNode;
let edgeA: DevnetNode;
let edgeB: DevnetNode;
/** The graphs, created once in `beforeAll`. */
let fixture: Fixture;

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

/**
 * A daemon reply. `json` is typed as the endpoint's 200 body: check `status`
 * before reading it (an error reply carries `{ error }` instead).
 */
interface Reply<T> {
  status: number;
  json: T;
}

const getTyped = <T>(node: DevnetNode, path: string): Promise<Reply<T>> => getJson(node, path);
const postTyped = <T>(node: DevnetNode, path: string, body: unknown): Promise<Reply<T>> => postJson(node, path, body);

async function listSubscriptions(node: DevnetNode): Promise<SubscriptionRow[]> {
  const res = await getTyped<{ subscriptions: SubscriptionRow[] }>(node, '/api/context-graph/subscriptions');
  expect(res.status, `node${node.num} GET /api/context-graph/subscriptions: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json.subscriptions;
}

/** The id of the catch-up job a subscribe queued (the completed-catch-up variant of the reply has none). */
function queuedJobId(reply: SubscribeResponse): string | undefined {
  const catchup = reply.catchup;
  return catchup !== undefined && 'jobId' in catchup ? catchup.jobId : undefined;
}

/**
 * Subscribe, retrying only while the node has not yet read the graph from the
 * chain (a retryable 503, or a numeric id the node has not seen yet: 404).
 */
async function subscribeWhenAdmitted(node: DevnetNode, contextGraphId: string): Promise<SubscribeResponse> {
  let last = '';
  return waitFor(`node${node.num} subscribes ${contextGraphId}`, 120_000, 3_000, async () => {
    const res = await postTyped<SubscribeResponse>(node, '/api/context-graph/subscribe', {
      contextGraphId,
      includeSharedMemory: true,
      syncMode: 'always-on',
    });
    if (res.status === 200) return res.json;
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
    const res = await getTyped<ContextGraphListResponse>(node, '/api/context-graph/list');
    if (res.status !== 200) return null;
    const rows = res.json.contextGraphs ?? [];
    return rows.some((row) => (row.onChainId ?? row.onChain?.id) === onChainId) ? true : null;
  });
}

/**
 * Arrange check for a test whose subject is the first subscribe: the edge holds no
 * subscription row for the graph, under either of its ids. It fails with that
 * message instead of letting a later assertion read someone else's leftovers.
 */
async function expectNoRowFor(node: DevnetNode, graph: RegisteredGraph): Promise<void> {
  const ids = (await listSubscriptions(node)).map((row) => row.contextGraphId);
  expect(ids, `node${node.num} must not yet be subscribed to ${graph.id}`).not.toContain(graph.id);
  expect(ids, `node${node.num} must not yet be subscribed to ${graph.id} by its hash`).not.toContain(graph.nameHash);
}

/** Wait for the promotion: a subscribed row keyed by the cleartext id, none keyed by the hash. */
async function waitForAdoption(node: DevnetNode, graph: RegisteredGraph): Promise<SubscriptionRow> {
  return waitFor(`node${node.num} adopts ${graph.id}`, 180_000, 3_000, async () => {
    const rows = await listSubscriptions(node);
    const adopted = rows.find((candidate) => candidate.contextGraphId === graph.id && candidate.subscribed);
    return adopted !== undefined && !rows.some((candidate) => candidate.contextGraphId === graph.nameHash)
      ? adopted
      : null;
  });
}

async function catchupStatus(node: DevnetNode, contextGraphId: string): Promise<CatchupStatusResponse | null> {
  const res = await getTyped<CatchupStatusResponse>(
    node,
    `/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`,
  );
  return res.status === 200 ? res.json : null;
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

/** The latest catch-up job's verdict, for a failure message. */
async function describeLatestJob(node: DevnetNode, contextGraphId: string): Promise<string> {
  const job = await catchupStatus(node, contextGraphId).catch(() => null);
  return `last catch-up job: ${job?.jobStatus ?? 'none'}${job?.error ? `, ${job.error}` : ''}`;
}

/**
 * Poll an edge until a subject's content in one view matches the author's, and
 * report the latest catch-up job's verdict if it never does. `whileWaiting`
 * runs on every poll that found no match yet; without it the poll only reads.
 */
async function pollContent(
  node: DevnetNode,
  contextGraphId: string,
  subject: string,
  view: View,
  expected: string[],
  label: string,
  budgetMs: number,
  whileWaiting?: () => Promise<void>,
): Promise<void> {
  try {
    await waitFor(`${label}: node${node.num} ${view} content of ${subject}`, budgetMs, 3_000, async () => {
      const rows = await subjectContent(node, contextGraphId, subject, view).catch(() => [] as string[]);
      if (rows.length > 0 && JSON.stringify(rows) === JSON.stringify(expected)) return rows;
      await whileWaiting?.();
      return null;
    });
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)} (${await describeLatestJob(node, contextGraphId)})`);
  }
}

/**
 * Wait for a subject's content to match the author's on an edge. Purely
 * observational: it never subscribes, retries or otherwise changes the node, so
 * the catch-up job a test started stays the latest one until the test itself
 * replaces it.
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
  await pollContent(node, contextGraphId, subject, view, expected, label, budgetMs);
}

/**
 * ARRANGE, idempotent: leave `graph` subscribed, adopted under its cleartext id
 * and converged on the author's VM content on `node`. It subscribes (under
 * `requestedId`) only when the node has no row for the graph, keyed by either
 * id; adoption and content are waits, which return at once when they already
 * hold. So it does the same thing whether or not another test, or an earlier
 * attempt of the same test, already subscribed this node.
 */
async function ensureConverged(node: DevnetNode, graph: RegisteredGraph, requestedId: string, label: string): Promise<void> {
  const rows = await listSubscriptions(node);
  if (!rows.some((row) => row.contextGraphId === graph.id || row.contextGraphId === graph.nameHash)) {
    await waitUntilChainSlotObserved(node, graph.onChainId);
    await subscribeWhenAdmitted(node, requestedId);
  }
  await waitForAdoption(node, graph);
  const expected = await subjectContent(author, graph.id, graph.subject, 'verifiable-memory');
  await waitForContent(node, graph.id, graph.subject, 'verifiable-memory', expected, label);
}

/**
 * The operator's recovery for a catch-up job that ended `failed`: a fresh
 * subscribe with `forceCatchup`. It mints a REPLACEMENT job (or, while a job is
 * still queued or running, hands that one back), and from then on the cleartext
 * id and the on-chain id name the latest job, not the one the first subscribe
 * returned. The superseded job stays readable by its own id.
 */
async function forceCatchup(
  node: DevnetNode,
  contextGraphId: string,
): Promise<{ status: number; jobId?: string; detail: string }> {
  const res = await postTyped<SubscribeResponse>(node, '/api/context-graph/subscribe', {
    contextGraphId,
    includeSharedMemory: true,
    syncMode: 'always-on',
    forceCatchup: true,
  });
  return {
    status: res.status,
    jobId: res.status === 200 ? queuedJobId(res.json) : undefined,
    detail: JSON.stringify(res.json),
  };
}

/**
 * Wait for content and, once a minute while it is missing, recover with a forced
 * catch-up. Only the SWM scenario calls this: its content depends on a holder's
 * RFC-64 authority pipeline, which can lag or trip its RPC circuit for a while
 * after a devnet starts (an operator recovers a short window this way; a node
 * whose circuit stays open needs a restart, and the suite fails rather than hide
 * it). Returns the id of the latest catch-up job, which is what the graph's
 * aliases must name afterwards: `firstJobId` when no recovery replaced it.
 */
async function recoverUntilContent(
  node: DevnetNode,
  contextGraphId: string,
  subject: string,
  view: View,
  expected: string[],
  label: string,
  firstJobId: string,
  budgetMs: number,
): Promise<string> {
  let latestJobId = firstJobId;
  let lastRetryAt = Date.now();
  await pollContent(node, contextGraphId, subject, view, expected, label, budgetMs, async () => {
    if (Date.now() - lastRetryAt < 60_000) return;
    lastRetryAt = Date.now();
    const forced = await forceCatchup(node, contextGraphId).catch(() => null);
    if (forced?.jobId !== undefined) latestJobId = forced.jobId;
  });
  return latestJobId;
}

/**
 * A catch-up job is readable by its id and names the graph, and both aliases of
 * the graph (its cleartext id and its on-chain id) name it as the latest job.
 */
async function expectAliasesName(node: DevnetNode, graph: RegisteredGraph, jobId: string, label: string): Promise<void> {
  const byJobId = await getTyped<CatchupStatusResponse>(node, `/api/sync/catchup-status?jobId=${encodeURIComponent(jobId)}`);
  expect(byJobId.status, `${label}: ${JSON.stringify(byJobId.json)}`).toBe(200);
  const named = byJobId.json;
  expect(named.resolvedContextGraphId ?? named.contextGraphId, `${label}: the job names the cleartext graph`).toBe(graph.id);
  await waitFor(`${label}: node${node.num} names job ${jobId} by cleartext id and on-chain id`, 30_000, 2_000, async () => {
    const [byCleartextId, byOnChainId] = await Promise.all([
      catchupStatus(node, graph.id),
      catchupStatus(node, graph.onChainId),
    ]);
    return byCleartextId?.jobId === jobId && byOnChainId?.jobId === jobId ? true : null;
  });
}

/** Register a public, open graph through the daemon API. */
async function registerPublicGraph(id: string): Promise<{ onChainId: string; nameHash: string }> {
  const created = await postJson(author, '/api/context-graph/create', {
    id,
    name: `Hash subscription ${id}`,
    description: 'devnet coverage for subscribing by on-chain name hash',
    accessPolicy: 0,
    publishPolicy: 1,
    register: true,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  expect(created.json.registered, JSON.stringify(created.json)).toBe(true);
  const onChainId = String(created.json.onChainId);
  expect(BigInt(onChainId)).toBeGreaterThan(0n);
  return { onChainId, nameHash: keccak(id) };
}

/** A registered graph holding one Knowledge Asset that the author has shared, then published to VM on chain. */
async function createPublishedGraph(id: string, name: string): Promise<RegisteredGraph> {
  const registration = await registerPublicGraph(id);
  const file = makeNquadsFile(import.meta.dirname, name, id);
  const published = await publishViaCli(author, id, file.path);
  expect(published.status, `publishing ${id} to VM`).toBe('confirmed');
  return { id, ...registration, subject: file.subject, value: name };
}

/** A registered graph holding one Knowledge Asset that the author has only shared to SWM. */
async function createSharedGraph(id: string, name: string): Promise<RegisteredGraph> {
  const registration = await registerPublicGraph(id);
  const file = makeNquadsFile(import.meta.dirname, name, id);
  const shared = await runDkgCli(author, [
    'ka', 'create', `${name}-${STAMP}`,
    '--context-graph-id', id,
    '--input-file', file.path,
    '--share',
  ], 120_000);
  expect(shared.code, `ka create --share failed\n${shared.stdout}\n${shared.stderr}`).toBe(0);
  return { id, ...registration, subject: file.subject, value: name };
}

/**
 * Register a graph straight on the real ContextGraphs contract, from a throwaway
 * wallet, with a name commitment whose preimage no node has ever seen.
 */
async function registerGraphNobodyHolds(): Promise<UnheldGraph> {
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
  return { nameHash, onChainId };
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
  // FIXTURE: every graph the tests use, created once and never changed again.
  beforeAll(async () => {
    const vm = await createPublishedGraph(`devnet-hash-sub-${STAMP}`, 'hashsub-vm');
    const forced = await createPublishedGraph(`devnet-hash-sub-forced-${STAMP}`, 'hashsub-forced');
    const swm = await createSharedGraph(`devnet-hash-sub-swm-${STAMP}`, 'hashsub-swm');
    const unheld = await registerGraphNobodyHolds();

    // The author holds all of it (store materialization can lag the CLI's return).
    for (const [graph, view] of [
      [vm, 'verifiable-memory'],
      [forced, 'verifiable-memory'],
      [swm, 'shared-working-memory'],
    ] as const) {
      await waitFor(`author ${view} content of ${graph.subject}`, 120_000, 3_000, async () => {
        const rows = await subjectContent(author, graph.id, graph.subject, view).catch(() => [] as string[]);
        return rows.length > 0 ? rows : null;
      });
    }
    fixture = Object.freeze({
      vm: Object.freeze(vm),
      forced: Object.freeze(forced),
      swm: Object.freeze(swm),
      unheld: Object.freeze(unheld),
    });
  }, 900_000);

  it('the real chain commits only keccak256 of each registered graph id, and the author holds what it published and shared', async () => {
    const storage = await contextGraphStorage();
    for (const graph of [fixture.vm, fixture.forced, fixture.swm]) {
      // The contract commits exactly the preimage's keccak: the property every
      // verifying edge relies on.
      const committed = String(await storage.getNameHash(BigInt(graph.onChainId))).toLowerCase();
      expect(committed, `on-chain name hash of ${graph.id}`).toBe(keccak(graph.id));
    }
    for (const [graph, view] of [
      [fixture.vm, 'verifiable-memory'],
      [fixture.forced, 'verifiable-memory'],
      [fixture.swm, 'shared-working-memory'],
    ] as const) {
      const content = await subjectContent(author, graph.id, graph.subject, view);
      expect(content.some((entry) => entry.includes(graph.value)), `author ${view} content of ${graph.id}`).toBe(true);
    }
  }, 300_000);

  it('an edge subscribed by name hash alone adopts the verified cleartext id and converges on the finalized VM data', async () => {
    const vmGraph = fixture.vm;
    // The edge knows nothing of the graph but what the chain says.
    await expectNoRowFor(edgeA, vmGraph);
    expect(await tryRowCount(edgeA, vmGraph.id, vmGraph.subject, 'verifiable-memory')).toBe(0);

    await waitUntilChainSlotObserved(edgeA, vmGraph.onChainId);
    const subscribed = await subscribeWhenAdmitted(edgeA, vmGraph.nameHash);
    // The route reports the id it subscribed: the cleartext one when a peer
    // revealed it within the request, else the hash (which the resolver then
    // promotes in the background).
    expect([vmGraph.id, vmGraph.nameHash]).toContain(subscribed.subscribed);
    // eslint-disable-next-line no-console
    console.log(`hash-sub: subscribe by hash answered with subscribed=${subscribed.subscribed} identity=${JSON.stringify(subscribed.identity ?? null)}`);

    const row = await waitForAdoption(edgeA, vmGraph);
    expect(keccak(row.contextGraphId), 'the adopted id is the preimage of the on-chain hash').toBe(vmGraph.nameHash);
    expect(row.identity, 'a resolved row carries no name-hash-only note').toBeUndefined();

    // What the hash could never reach: the finalized VM copy, published before
    // the edge subscribed, byte-identical to the author's.
    const vmExpected = await subjectContent(author, vmGraph.id, vmGraph.subject, 'verifiable-memory');
    expect(vmExpected.some((entry) => entry.includes(vmGraph.value))).toBe(true);
    await waitForContent(edgeA, vmGraph.id, vmGraph.subject, 'verifiable-memory', vmExpected, 'name-hash subscribe');

    // The catch-up job the subscribe minted is reachable by its id, by the
    // cleartext id and by the on-chain id, and always names the cleartext graph.
    // The wait above only reads, so nothing has replaced it: the job the subscribe
    // returned is still the latest one.
    const jobId = queuedJobId(subscribed);
    expect(jobId, JSON.stringify(subscribed)).toEqual(expect.any(String));
    await expectAliasesName(edgeA, vmGraph, jobId!, 'name-hash subscribe');
    // Looked up by the hash it was subscribed with (#2779), a job created under
    // the hash names the cleartext graph once it resolved. When the subscribe
    // request itself resolved the hash (the usual case with a connected holder)
    // the job is keyed by the cleartext id only and a lookup by the hash finds
    // no job (404 "No catch-up job found"). That is a product inconsistency
    // reported in the PR that added this suite, not pinned here; this branch
    // therefore does not run when the holder answers within the request.
    if (subscribed.subscribed === vmGraph.nameHash) {
      const byHash = await waitFor(`node${edgeA.num} catch-up status by name hash`, 60_000, 2_000, async () => catchupStatus(edgeA, vmGraph.nameHash));
      expect(byHash.resolvedContextGraphId ?? byHash.contextGraphId).toBe(vmGraph.id);
      if (byHash.identity) {
        // `satisfies` types the expected object against the daemon's declaration:
        // vitest types toMatchObject loosely, so without it a changed identity
        // state spelling would compile here and fail only in a long devnet run.
        expect(byHash.identity).toMatchObject(
          { state: 'resolved', nameHash: vmGraph.nameHash, contextGraphId: vmGraph.id } satisfies Partial<CatchupContextGraphIdentity>,
        );
      }
    }
  }, 900_000);

  it('a second edge subscribed by numeric on-chain id lands on the same cleartext graph and converges on VM (#2758)', async () => {
    const vmGraph = fixture.vm;
    await expectNoRowFor(edgeB, vmGraph);
    await waitUntilChainSlotObserved(edgeB, vmGraph.onChainId);
    const subscribed = await subscribeWhenAdmitted(edgeB, `#${vmGraph.onChainId}`);
    expect(subscribed.onChainReference, JSON.stringify(subscribed)).toMatchObject({ onChainId: vmGraph.onChainId });
    // The numeric id names the same slot; the row is never keyed by the number.
    await waitForAdoption(edgeB, vmGraph);
    expect((await listSubscriptions(edgeB)).map((row) => row.contextGraphId)).not.toContain(vmGraph.onChainId);

    const vmExpected = await subjectContent(author, vmGraph.id, vmGraph.subject, 'verifiable-memory');
    await waitForContent(edgeB, vmGraph.id, vmGraph.subject, 'verifiable-memory', vmExpected, 'numeric-id subscribe');
  }, 900_000);

  // The operator's recovery for a catch-up job that did not deliver: a forced
  // catch-up replaces the graph's latest job. The recovery step of the SWM
  // scenario below depends on that, so it is pinned here on its own, on a graph
  // that has already converged and so needs no fault to be injected. The graph is
  // this test's own (`fixture.forced`), converged here by the arrange step, so
  // the test neither needs nor disturbs the edges' state in the tests around it.
  it('a forced catch-up mints a replacement job that both aliases follow, keeps the superseded job readable, and leaves the content intact', async () => {
    const graph = fixture.forced;
    await ensureConverged(edgeA, graph, graph.nameHash, 'arranging the converged edge');

    const first = await waitFor(`node${edgeA.num} has a settled catch-up job for ${graph.id}`, 120_000, 3_000, async () => {
      const found = await catchupStatus(edgeA, graph.id);
      return found !== null && found.jobStatus !== 'queued' && found.jobStatus !== 'running' ? found : null;
    });

    const forced = await forceCatchup(edgeA, graph.id);
    expect(forced.status, forced.detail).toBe(200);
    expect(forced.jobId, forced.detail).toEqual(expect.any(String));
    expect(forced.jobId, 'a settled graph gets a REPLACEMENT job, not the old one back').not.toBe(first.jobId);

    // Both aliases now name the replacement; the superseded job is still there by its id.
    await expectAliasesName(edgeA, graph, forced.jobId!, 'forced catch-up');
    const superseded = await getTyped<CatchupStatusResponse>(edgeA, `/api/sync/catchup-status?jobId=${encodeURIComponent(first.jobId)}`);
    expect(superseded.status, JSON.stringify(superseded.json)).toBe(200);
    expect(superseded.json.jobId).toBe(first.jobId);

    // The replacement runs to a verdict, and the content is exactly what it was.
    // The verdict itself is not what this test pins: this graph has no shared
    // working memory, so a catch-up that also asks for it can settle as
    // `unreachable` (the SWM plane stalls on empty answers) while the VM content
    // is intact, and the aliases follow that latest job all the same.
    const settled = await waitFor(`node${edgeA.num} replacement catch-up job settles`, 240_000, 3_000, async () => {
      const found = await catchupStatus(edgeA, graph.id);
      return found !== null && found.jobId === forced.jobId && found.jobStatus !== 'queued' && found.jobStatus !== 'running' ? found : null;
    });
    // eslint-disable-next-line no-console
    console.log(`hash-sub: forced catch-up job ${settled.jobId} settled as ${settled.jobStatus}`);
    const vmExpected = await subjectContent(author, graph.id, graph.subject, 'verifiable-memory');
    await waitForContent(edgeA, graph.id, graph.subject, 'verifiable-memory', vmExpected, 'after the forced catch-up');
  }, 900_000);

  // Kept apart from the tests above on purpose, on a graph that was only shared.
  // Holders serve a graph's shared working memory only once their RFC-64
  // authority pipeline has accepted it (a finalized authority index polled every
  // few minutes), and that pipeline can lag or trip its RPC circuit for many
  // minutes after a devnet starts (`chain event log moved`, `RFC-64 authority
  // RPC circuit is open`). This is the one scenario that recovers explicitly.
  it('the SWM a holder shared before the edges subscribed backfills on both, subscribed by hash and by numeric id', async () => {
    const swmGraph = fixture.swm;
    const swmExpected = await subjectContent(author, swmGraph.id, swmGraph.subject, 'shared-working-memory');
    expect(swmExpected.some((entry) => entry.includes(swmGraph.value))).toBe(true);

    await expectNoRowFor(edgeA, swmGraph);
    await expectNoRowFor(edgeB, swmGraph);
    await waitUntilChainSlotObserved(edgeA, swmGraph.onChainId);
    const subscribedA = await subscribeWhenAdmitted(edgeA, swmGraph.nameHash);
    await waitForAdoption(edgeA, swmGraph);
    await waitUntilChainSlotObserved(edgeB, swmGraph.onChainId);
    const subscribedB = await subscribeWhenAdmitted(edgeB, `#${swmGraph.onChainId}`);
    await waitForAdoption(edgeB, swmGraph);

    // The jobs the subscribes minted, checked before any recovery can replace
    // them. (A subscribe that answered under the hash keyed its job by the hash,
    // and its cleartext alias is not asserted here.)
    const edges = [
      { node: edgeA, subscribed: subscribedA, label: 'name-hash subscribe' },
      { node: edgeB, subscribed: subscribedB, label: 'numeric-id subscribe' },
    ];
    const firstJobIds = new Map<DevnetNode, string>();
    for (const { node, subscribed, label } of edges) {
      const jobId = queuedJobId(subscribed);
      expect(jobId, JSON.stringify(subscribed)).toEqual(expect.any(String));
      firstJobIds.set(node, jobId!);
      if (subscribed.subscribed === swmGraph.id) await expectAliasesName(node, swmGraph, jobId!, `${label} (first job)`);
    }

    // Recover explicitly, and expect the aliases to follow whichever job is latest.
    for (const { node, label } of edges) {
      const latestJobId = await recoverUntilContent(
        node, swmGraph.id, swmGraph.subject, 'shared-working-memory', swmExpected, label,
        firstJobIds.get(node)!, 600_000,
      );
      await expectAliasesName(node, swmGraph, latestJobId, `${label} (latest job)`);
    }
  }, 1_800_000);

  it('a graph registered on chain whose cleartext no peer holds stays hash-only: nothing is invented', async () => {
    const { nameHash, onChainId } = fixture.unheld;

    await waitUntilChainSlotObserved(edgeB, onChainId);
    const before = (await listSubscriptions(edgeB)).map((row) => row.contextGraphId);
    expect(before, `node${edgeB.num} must not yet be subscribed to the unheld graph`).not.toContain(nameHash);
    const subscribed = await subscribeWhenAdmitted(edgeB, nameHash);
    expect(subscribed.subscribed).toBe(nameHash);
    expect(subscribed.identity, JSON.stringify(subscribed)).toMatchObject({ state: 'name-hash-only', nameHash, onChainId } satisfies Partial<CatchupContextGraphIdentity>);

    // Give the resolver several rounds against every connected peer; it must
    // still find nothing, and must not have made up an id.
    await sleep(30_000);
    const after = await listSubscriptions(edgeB);
    const row = after.find((candidate) => candidate.contextGraphId === nameHash);
    expect(row, 'the hash-keyed row stays').toBeDefined();
    expect(row!.subscribed).toBe(true);
    expect(row!.identity).toMatchObject({ state: 'name-hash-only', nameHash, onChainId } satisfies Partial<CatchupContextGraphIdentity>);
    const added = after.map((candidate) => candidate.contextGraphId).filter((id) => !before.includes(id));
    expect(added, 'no other row appeared for the unknown graph').toEqual([nameHash]);

    // Catch-up cannot succeed under a name nobody holds; it says so instead of asking for a retry.
    const status = await waitFor(`node${edgeB.num} catch-up settles for the hash-only graph`, 120_000, 3_000, async () => {
      const found = await catchupStatus(edgeB, nameHash);
      return found !== null && found.jobStatus !== 'queued' && found.jobStatus !== 'running' ? found : null;
    });
    expect(status.jobStatus).toBe('unreachable' satisfies CatchupJobState);
    expect(status.identity).toMatchObject({ state: 'name-hash-only', nameHash, onChainId } satisfies Partial<CatchupContextGraphIdentity>);
    // The verdict is the name-hash-only note, not the generic "no peer could deliver" one.
    expect(status.error).toBe(status.identity?.message);
    expect(status.error).toContain('on-chain name hash');
  }, 900_000);
});
