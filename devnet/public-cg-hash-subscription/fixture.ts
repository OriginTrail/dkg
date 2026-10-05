/**
 * The graphs the hash-subscription devnet suite runs against, and how they are made:
 * registered through the daemon API, or straight on the real ContextGraphs contract
 * from a throwaway wallet. Everything here is created once, before any test, and
 * never changes afterwards; a test never creates a graph.
 *
 * Nothing in this module reads module-level state: the devnet, the node that
 * authors the graphs, the run stamp and the directory the artifact files go to are
 * passed in (`FixtureEnv`), so a caller sees what a graph depends on.
 *
 * Which graph serves which test, and why they are separate graphs, is in README.md
 * ("Structure").
 */
import { expect } from 'vitest';
import { ethers } from 'ethers';
import {
  contractAt,
  fundTrac,
  makeNquadsFile,
  nextNonce,
  postJson,
  publishViaCli,
  runDkgCli,
  setEth,
  waitFor,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';
import type { Daemon } from './daemon.js';

/** The keccak256 of the UTF-8 id, lower-case hex: what the contract commits as a graph's name hash. */
export const keccak = (id: string): string => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();

/** A public graph registered on chain, holding one Knowledge Asset by one subject. */
export interface RegisteredGraph {
  readonly id: string;
  readonly onChainId: string;
  readonly nameHash: string;
  readonly subject: string;
  readonly value: string;
}

/** A graph registered on chain straight through the contract, whose preimage no node has ever seen. */
export interface UnheldGraph {
  readonly nameHash: string;
  readonly onChainId: string;
}

/**
 * Registered the same way, but the preimage (`id`) is known to this suite: no node
 * holds it until test 7 reveals it by subscribing the cleartext id.
 */
export interface RevealableGraph extends UnheldGraph {
  readonly id: string;
}

/** Everything the tests share. Built once, never modified afterwards. */
export interface Fixture {
  /** Its Knowledge Asset is published to VM on chain: edges must fetch it from a holder (tests 2 and 3). */
  readonly vm: RegisteredGraph;
  /** Same shape as `vm`, kept for the forced catch-up test alone (test 4). */
  readonly forced: RegisteredGraph;
  /** Its Knowledge Asset is only shared to SWM: edges must backfill it from a peer (test 5). */
  readonly swm: RegisteredGraph;
  /** Registered on chain with a name commitment nobody can resolve (test 6). */
  readonly unheld: UnheldGraph;
  /** Registered on chain with a name only this suite knows, revealed by test 7 alone. */
  readonly late: RevealableGraph;
}

/** What a graph is created with and by. */
export interface FixtureEnv {
  readonly state: DevnetState;
  /** The node that registers, shares and publishes the graphs, and holds their content. */
  readonly author: DevnetNode;
  /** Makes this run's graph ids and artifact names unique on a devnet that has run the suite before. */
  readonly stamp: string;
  /** The suite directory: the n-quads artifact files are written to its `turns/`. */
  readonly artifactDir: string;
}

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
export async function contextGraphStorage(state: DevnetState): Promise<ethers.Contract> {
  const facade = contractAt(state, 'ContextGraphs', CG_FACADE_ABI);
  return new ethers.Contract(await facade.contextGraphStorage(), CG_STORAGE_ABI, state.provider);
}

/** Register a public, open graph through the daemon API. */
async function registerPublicGraph(env: FixtureEnv, id: string): Promise<{ onChainId: string; nameHash: string }> {
  const created = await postJson(env.author, '/api/context-graph/create', {
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
export async function createPublishedGraph(env: FixtureEnv, id: string, name: string): Promise<RegisteredGraph> {
  const registration = await registerPublicGraph(env, id);
  const file = makeNquadsFile(env.artifactDir, name, id);
  const published = await publishViaCli(env.author, id, file.path);
  expect(published.status, `publishing ${id} to VM`).toBe('confirmed');
  return { id, ...registration, subject: file.subject, value: name };
}

/** A registered graph holding one Knowledge Asset that the author has only shared to SWM. */
export async function createSharedGraph(env: FixtureEnv, id: string, name: string): Promise<RegisteredGraph> {
  const registration = await registerPublicGraph(env, id);
  const file = makeNquadsFile(env.artifactDir, name, id);
  const shared = await runDkgCli(env.author, [
    'ka', 'create', `${name}-${env.stamp}`,
    '--context-graph-id', id,
    '--input-file', file.path,
    '--share',
  ], 120_000);
  expect(shared.code, `ka create --share failed\n${shared.stdout}\n${shared.stderr}`).toBe(0);
  return { id, ...registration, subject: file.subject, value: name };
}

/**
 * Register a public, open graph straight on the real ContextGraphs contract, from a
 * throwaway wallet, committing `nameHash`. No node holds its preimage unless the
 * caller makes one hold it: the daemon never registered it, so nothing but the
 * chain event tells the network it exists.
 */
export async function registerSlotOnChain(state: DevnetState, nameHash: string): Promise<UnheldGraph> {
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

/**
 * Create every graph the tests use, wait until the author holds their content
 * (store materialization can lag the CLI's return), and freeze the result.
 */
export async function buildFixture(env: FixtureEnv, daemon: Pick<Daemon, 'pollSubjectContent'>): Promise<Fixture> {
  const vm = await createPublishedGraph(env, `devnet-hash-sub-${env.stamp}`, 'hashsub-vm');
  const forced = await createPublishedGraph(env, `devnet-hash-sub-forced-${env.stamp}`, 'hashsub-forced');
  const swm = await createSharedGraph(env, `devnet-hash-sub-swm-${env.stamp}`, 'hashsub-swm');
  const unheld = await registerSlotOnChain(env.state, keccak(`devnet-nobody-holds-this-name/${env.stamp}`));
  // Test 7's name: only this suite knows it, and nothing has been created under it.
  const lateId = `devnet-hash-sub-late-${env.stamp}`;
  const late: RevealableGraph = { id: lateId, ...(await registerSlotOnChain(env.state, keccak(lateId))) };

  // The author holds all of it.
  for (const [graph, view] of [
    [vm, 'verifiable-memory'],
    [forced, 'verifiable-memory'],
    [swm, 'shared-working-memory'],
  ] as const) {
    await waitFor(`author ${view} content of ${graph.subject}`, 120_000, 3_000, async () => {
      const rows = await daemon.pollSubjectContent(env.author, graph.id, graph.subject, view);
      return rows.length > 0 ? rows : null;
    });
  }
  return Object.freeze({
    vm: Object.freeze(vm),
    forced: Object.freeze(forced),
    swm: Object.freeze(swm),
    unheld: Object.freeze(unheld),
    late: Object.freeze(late),
  });
}
