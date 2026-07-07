/**
 * Shared devnet test harness (10.0.2 PR-coverage suites).
 *
 * Historically each `devnet/<suite>/automated.test.ts` re-implemented the same
 * ~150 lines of bootstrap (read node config, probe hardhat, resolve contracts,
 * spawn the CLI, fund a PCA). The 10.0.2 PR-coverage suites instead import this
 * one validated module so each suite carries only its PR-specific assertions.
 *
 * ISOLATION INVARIANT (read before adding a suite):
 *   The 10.0.2 sweep runs every suite + the destructive orchestrator stages
 *   (revocation, unclean-restart, soak) against ONE shared devnet, in sequence.
 *   A suite MUST therefore only ever mutate EPHEMERAL, SELF-CREATED entities:
 *     - fresh PCAs (createFreshPca) funded via hardhat_setStorageAt,
 *     - fresh throwaway wallets (ethers.Wallet.createRandom),
 *     - its own freshly-created context graphs / sub-graphs.
 *   NEVER remove a real node's operational wallet, transfer a node's identity,
 *   or pollute the shared `devnet-test` CG with state a later suite depends on.
 *
 * TIME-WARP INVARIANT:
 *   evm_increaseTime advances the SHARED chain clock irreversibly and breaks
 *   in-flight Random Sampling challenges. Any suite that time-warps must be
 *   ordered AFTER the RS/consensus suites (and is flagged in package.json).
 */
import { expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const RPC = process.env.DEVNET_RPC ?? 'http://127.0.0.1:8545';
export const DEVNET_DIR = join(REPO_ROOT, '.devnet');
export const CONTEXT_GRAPH = 'devnet-test';

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * fetch that retries transient network errors (ECONNRESET / socket hang-up /
 * timeouts) a few times before giving up. Under sustained load a healthy node
 * can momentarily reset a connection; without this a single blip fails a whole
 * suite (observed: a 1/36 ECONNRESET on an RS status poll in the stability loop).
 * Only RETHROWS after all attempts — HTTP error *statuses* are returned as-is
 * (they aren't thrown by fetch), so this never masks a real 4xx/5xx.
 */
export async function fetchRetry(
  url: string,
  init?: RequestInit,
  tries = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

// ───────────────────────────── types ─────────────────────────────

export interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
  identityId: bigint;
  opWallets: Array<{ privateKey: string; address: string }>;
  admin: { privateKey: string; address: string };
}

export interface DevnetState {
  provider: ethers.JsonRpcProvider;
  hub: ethers.Contract;
  addrs: Record<string, string>;
  token: ethers.Contract;
  nft: ethers.Contract;
  kas: ethers.Contract;
  rss: ethers.Contract;
  nodes: Record<number, DevnetNode>;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Extract the final JSON object a CLI command prints after human/log lines.
 * Many devnet suites use JSON mode on commands that still emit progress text;
 * scanning from the last object start keeps those assertions consistent.
 */
export function parseLastJsonBlock<T extends Record<string, unknown> = Record<string, unknown>>(
  stdout: string,
  label = 'CLI stdout',
): T {
  for (let i = stdout.lastIndexOf('\n{'); i >= 0; i = i === 0 ? -1 : stdout.lastIndexOf('\n{', i - 1)) {
    const candidate = stdout.slice(i).trim();
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep scanning earlier object starts
    }
  }

  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error(`no JSON object in ${label}:\n${stdout.slice(0, 2000)}`);
  }
}

// ──────────────────────── node config / identity ────────────────────────

export function readNodeConfig(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(
      `Devnet node${num} home missing — run ./scripts/devnet.sh start 6 first`,
    );
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const wallets = JSON.parse(readFileSync(join(home, 'wallets.json'), 'utf8'));
  const opWallets: Array<{ privateKey: string; address: string }> =
    wallets.wallets ?? [];
  if (opWallets.length === 0) {
    throw new Error(`Devnet node${num} has no operational wallet`);
  }
  let authToken = '';
  if (existsSync(join(home, 'auth.token'))) {
    authToken =
      readFileSync(join(home, 'auth.token'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return {
    num,
    apiPort: config.apiPort,
    home,
    authToken,
    identityId: 0n,
    opWallets,
    admin: wallets.adminWallet,
  };
}

export async function fetchStatus(
  node: DevnetNode,
): Promise<{ identityId: bigint; nodeRole: string }> {
  const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}/api/status`);
  if (!res.ok) throw new Error(`node${node.num} /api/status failed: ${res.status}`);
  const json = (await res.json()) as { identityId: string; nodeRole: string };
  return { identityId: BigInt(json.identityId), nodeRole: json.nodeRole };
}

export async function ensureIdentity(node: DevnetNode): Promise<bigint> {
  const status = await fetchStatus(node);
  if (status.identityId > 0n) return status.identityId;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  await fetch(`http://127.0.0.1:${node.apiPort}/api/identity/ensure`, {
    method: 'POST',
    headers,
  });
  for (let i = 0; i < 30; i++) {
    const st = await fetchStatus(node);
    if (st.identityId > 0n) return st.identityId;
    await sleep(1000);
  }
  throw new Error(`node${node.num} did not register identity within 30s`);
}

/**
 * Resolve identities for nodes 1..count. Defaults to the 4 CORE nodes — the
 * PR-coverage suites publish from cores / use fresh PCAs and never need edge
 * identities, and edge nodes 5-6 can take 30s+ each to register (60s of dead
 * polling per suite). Pass count=6 only if a suite genuinely exercises edges.
 */
export async function ensureAllIdentities(
  state: DevnetState,
  count = 4,
): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const node = state.nodes[i]!;
    try {
      node.identityId = await ensureIdentity(node);
    } catch (err) {
      if (i >= 5) {
        // edge nodes are best-effort
        // eslint-disable-next-line no-console
        console.warn(`node${i} ensureIdentity skipped: ${(err as Error).message}`);
      } else {
        throw err;
      }
    }
  }
}

// ───────────────────────────── CLI ─────────────────────────────

export function runDkgCli(
  node: DevnetNode,
  args: string[],
  timeoutMs = 60_000,
): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'packages/cli/dist/cli.js'), ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DKG_NO_BLUE_GREEN: '1',
          DKG_HOME: node.home,
          DKG_API_PORT: String(node.apiPort),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectResult(new Error(`dkg CLI timeout after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
  });
}

export interface PublishResult {
  status: string;
  kaId?: bigint;
  txHash?: string;
  raw: string;
}

export interface KaLifecycleOptions {
  kaName: string;
  contextGraphId: string;
  inputFile: string;
  /** Extra args appended to `ka create` (e.g. --sub-graph-name). */
  createArgs?: string[];
  /** Extra args appended to `ka publish` (e.g. --publish-epochs, --publisher-node-identity-id). */
  publishArgs?: string[];
}

/**
 * The two-step #1410 KA publish lifecycle (`ka create --share` stages WM ->
 * finalize -> SWM, then `ka publish` lands SWM -> VM on-chain) with its output
 * parsing, in ONE place. `runCli` abstracts how a suite spawns the CLI — each
 * suite keeps its own node/env/timeout mechanics — while this helper owns the
 * argument contract and the stdout contract (`Status:`, `KA ID:`, `Tx hash:`).
 * Throws on a non-zero exit of either step. Status/kaId ASSERTIONS stay with
 * callers: accepted statuses differ per scenario (e.g. tentative-tolerant
 * suites). `status` is returned lowercased; `kaId` is undefined when no
 * "KA ID:" line was printed.
 */
export async function runKaPublishLifecycle(
  runCli: (args: string[]) => Promise<CliResult>,
  opts: KaLifecycleOptions,
): Promise<PublishResult> {
  const created = await runCli([
    'ka', 'create', opts.kaName,
    '--context-graph-id', opts.contextGraphId,
    '--input-file', opts.inputFile,
    '--share',
    ...(opts.createArgs ?? []),
  ]);
  if (created.code !== 0) {
    throw new Error(
      `ka create --share ${opts.kaName} failed (exit ${created.code})\nstdout: ${created.stdout}\nstderr: ${created.stderr}`,
    );
  }
  const published = await runCli([
    'ka', 'publish', opts.kaName,
    '--context-graph-id', opts.contextGraphId,
    ...(opts.publishArgs ?? []),
  ]);
  if (published.code !== 0) {
    throw new Error(
      `ka publish ${opts.kaName} failed (exit ${published.code})\nstdout: ${published.stdout}\nstderr: ${published.stderr}`,
    );
  }
  const status = (/Status:\s*(\w+)/i.exec(published.stdout)?.[1] ?? 'unknown').toLowerCase();
  const kaMatch = /K[AC] ID:\s*(\d+)/i.exec(published.stdout);
  const txMatch = /Tx hash:\s*(0x[0-9a-fA-F]+)/i.exec(published.stdout);
  return {
    status,
    kaId: kaMatch ? BigInt(kaMatch[1]!) : undefined,
    txHash: txMatch?.[1],
    raw: published.stdout,
  };
}

const PUBLISH_OK = ['confirmed', 'finalized', 'tentative'];
let publishSeq = 0;

export async function publishViaCli(
  node: DevnetNode,
  contextGraph: string,
  filePath: string,
  options: { publisherNodeIdentityId?: bigint; extraArgs?: string[] } = {},
): Promise<PublishResult> {
  const publishArgs: string[] = [];
  if (options.publisherNodeIdentityId !== undefined) {
    publishArgs.push('--publisher-node-identity-id', String(options.publisherNodeIdentityId));
  }
  if (options.extraArgs) publishArgs.push(...options.extraArgs);
  const result = await runKaPublishLifecycle((args) => runDkgCli(node, args), {
    kaName: `harness-pub-${Date.now().toString(36)}-${++publishSeq}`,
    contextGraphId: contextGraph,
    inputFile: filePath,
    publishArgs,
  });
  expect(
    PUBLISH_OK,
    `ka publish status="${result.status}", expected one of ${PUBLISH_OK.join('/')}\n${result.raw}`,
  ).toContain(result.status);
  expect(result.kaId, `ka publish surfaced no positive "KA ID:" (kaId=${result.kaId})\n${result.raw}`).toBeGreaterThan(0n);
  return result;
}

// ───────────────────────────── n-quads files ─────────────────────────────

let nqCounter = 0;

/** Write n-quads `lines` (each WITHOUT trailing ` .`) into the suite's turns dir. */
export function writeNquads(suiteDir: string, name: string, lines: string[]): string {
  const dir = join(suiteDir, 'turns');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${++nqCounter}.nq`);
  writeFileSync(path, lines.map((l) => `${l} .`).join('\n') + '\n');
  return path;
}

/**
 * Make a minimal single-entity n-quads file (schema.org/name + description)
 * in `contextGraph`, with a unique subject. `uniq` defaults to a monotonic
 * counter (Date.now() is unavailable inside workflow scripts but fine here).
 */
export function makeNquadsFile(
  suiteDir: string,
  name: string,
  contextGraph: string,
  objectTriples?: Array<{ predicate: string; object: string }>,
): { path: string; subject: string } {
  const subject = `urn:test:${name}:${Date.now()}:${++nqCounter}`;
  const g = `did:dkg:context-graph:${contextGraph}`;
  const triples =
    objectTriples && objectTriples.length > 0
      ? objectTriples.map((t) => `<${subject}> <${t.predicate}> ${t.object} <${g}>`)
      : [
          `<${subject}> <https://schema.org/name> "${name}" <${g}>`,
          `<${subject}> <https://schema.org/description> "devnet 10.0.2 coverage" <${g}>`,
        ];
  const path = writeNquads(suiteDir, name, triples);
  return { path, subject };
}

// ───────────────────────────── chain ─────────────────────────────

async function loadContractAddresses(
  provider: ethers.JsonRpcProvider,
  hubAddress: string,
): Promise<{ hub: ethers.Contract; addrs: Record<string, string> }> {
  const hub = new ethers.Contract(
    hubAddress,
    [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ],
    provider,
  );
  const get = (n: string) => hub.getContractAddress(n) as Promise<string>;
  const getAsset = (n: string) => hub.getAssetStorageAddress(n) as Promise<string>;
  const addrs: Record<string, string> = {
    Hub: hubAddress,
    DKGKnowledgeAssets: await getAsset('DKGKnowledgeAssets'),
    DKGPublishingConvictionNFT: await get('DKGPublishingConvictionNFT'),
    Token: await get('Token'),
    EpochStorageV8: await get('EpochStorageV8'),
    Chronos: await get('Chronos'),
    RandomSamplingStorage: await get('RandomSamplingStorage'),
    StakingV10: await get('StakingV10'),
    ParametersStorage: await get('ParametersStorage'),
    IdentityStorage: await get('IdentityStorage'),
    ProfileStorage: await get('ProfileStorage'),
  };
  // Optional contracts (present only after the relevant PR's deploy script ran).
  for (const opt of [
    'ContextGraphs',
    'ContextGraphStorage',
    'ContextGraphWaiverStorage',
    'PublishingConviction', // upgradeable logic (registerAgents/clearAgents live here, not the NFT wrapper)
    'PublishingConvictionStorage',
  ]) {
    try {
      const a = await get(opt);
      if (a && a !== ethers.ZeroAddress) addrs[opt] = a;
    } catch {
      /* not registered in this Hub */
    }
  }
  return { hub, addrs };
}

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)',
  'function getAddress() view returns (address)',
];

const NFT_ABI = [
  'function createAccount(uint96, uint72) external returns (uint256)',
  'function registerAgent(uint256, address) external',
  'function agentToAccountId(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function windowSpent(uint256, uint40) view returns (uint96)',
  'function getCurrentBillingWindow(uint256) view returns (uint40)',
  'function settle(uint256) external',
  'event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint16 discountBps, uint40 createdAtEpoch, uint40 expiresAtEpoch)',
];

const KAS_ABI = [
  'function getLatestMerkleRootAuthor(uint256) view returns (address)',
];

/** Probe hardhat + load the devnet state. Returns null if no devnet is up. */
export async function detectDevnet(nodeCount = 6): Promise<DevnetState | null> {
  if (!existsSync(DEVNET_DIR)) return null;
  try {
    const probe = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    if (!probe.ok) return null;
  } catch {
    return null;
  }
  const contractsPath = join(
    REPO_ROOT,
    'packages/evm-module/deployments/localhost_contracts.json',
  );
  if (!existsSync(contractsPath)) return null;
  const contractsJson = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const hubAddress: string = contractsJson.contracts?.Hub?.evmAddress ?? contractsJson.Hub;
  if (!hubAddress) return null;

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: 'localhost' });
  const { hub, addrs } = await loadContractAddresses(provider, hubAddress);

  const rssAbi = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/evm-module/abi/RandomSamplingStorage.json'), 'utf8'),
  );

  const nodes: Record<number, DevnetNode> = {};
  for (let i = 1; i <= nodeCount; i++) nodes[i] = readNodeConfig(i);

  return {
    provider,
    hub,
    addrs,
    token: new ethers.Contract(addrs.Token, TOKEN_ABI, provider),
    nft: new ethers.Contract(addrs.DKGPublishingConvictionNFT, NFT_ABI, provider),
    kas: new ethers.Contract(addrs.DKGKnowledgeAssets, KAS_ABI, provider),
    rss: new ethers.Contract(addrs.RandomSamplingStorage, rssAbi, provider),
    nodes,
  };
}

/** Build a contract handle for any Hub-registered contract with a custom ABI. */
export function contractAt(
  state: DevnetState,
  name: string,
  abi: string[] | ethers.InterfaceAbi,
): ethers.Contract {
  const addr = state.addrs[name];
  if (!addr) throw new Error(`contract ${name} not resolved (not in Hub / not deployed)`);
  return new ethers.Contract(addr, abi, state.provider);
}

/** Raw nonce read (ethers' client cache races hardhat automine on rapid txs). */
export async function nextNonce(
  provider: ethers.JsonRpcProvider,
  address: string,
): Promise<number> {
  const raw = await provider.send('eth_getTransactionCount', [address, 'latest']);
  return parseInt(raw, 16);
}

export async function setEth(
  state: DevnetState,
  address: string,
  eth = '100',
): Promise<void> {
  await state.provider.send('hardhat_setBalance', [
    address,
    '0x' + ethers.parseEther(eth).toString(16),
  ]);
}

/**
 * Fund `address` with `trac` TRAC via direct storage write.
 * Token = Ownable, ERC20, AccessControl → ERC20 _balances mapping at slot 1.
 */
export async function fundTrac(
  state: DevnetState,
  address: string,
  trac: bigint,
): Promise<void> {
  const tokenAddress = await state.token.getAddress();
  const slotKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, 1n]),
  );
  await state.provider.send('hardhat_setStorageAt', [
    tokenAddress,
    slotKey,
    ethers.zeroPadValue(ethers.toBeHex(trac), 32),
  ]);
  const got: bigint = await state.token.balanceOf(address);
  if (got !== trac) {
    throw new Error(
      `fundTrac: setStorageAt mismatch (expected ${trac}, got ${got}); ERC20 _balances slot moved`,
    );
  }
}

export interface FreshPca {
  accountId: bigint;
  admin: ethers.Wallet;
}

/**
 * Create an ISOLATED PCA owned by a brand-new throwaway wallet, funded via
 * storage writes (never depletes the deployer / a real node). Returns the
 * accountId and the owner wallet (so the suite can transfer / clearAgents /
 * registerAgents against an entity nothing else in the sweep depends on).
 */
export async function createFreshPca(
  state: DevnetState,
  opts: { committedTrac?: bigint; primaryNode?: bigint } = {},
): Promise<FreshPca> {
  const committed = opts.committedTrac ?? ethers.parseEther('500000');
  const admin = ethers.Wallet.createRandom().connect(state.provider);
  await setEth(state, admin.address, '100');
  await fundTrac(state, admin.address, committed + ethers.parseEther('100000'));

  const tokenAsAdmin = state.token.connect(admin) as ethers.Contract;
  const nftAsAdmin = state.nft.connect(admin) as ethers.Contract;
  const nftAddress = await state.nft.getAddress();

  await (
    await tokenAsAdmin.approve(nftAddress, committed, {
      nonce: await nextNonce(state.provider, admin.address),
    })
  ).wait();
  const createReceipt = await (
    await nftAsAdmin.createAccount(committed, opts.primaryNode ?? 0n, {
      nonce: await nextNonce(state.provider, admin.address),
    })
  ).wait();

  let accountId = 0n;
  const iface = new ethers.Interface([
    'event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint16 discountBps, uint40 createdAtEpoch, uint40 expiresAtEpoch)',
  ]);
  for (const log of createReceipt?.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'AccountCreated') {
        accountId = parsed.args.accountId as bigint;
        break;
      }
    } catch {
      /* other contract's event */
    }
  }
  if (accountId === 0n) throw new Error('createFreshPca: AccountCreated not found');
  return { accountId, admin };
}

export async function timeWarpSeconds(
  provider: ethers.JsonRpcProvider,
  seconds: number,
): Promise<void> {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

// ───────────────────────────── HTTP / query ─────────────────────────────

export async function getJson(
  node: DevnetNode,
  path: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}${path}`, { headers });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

export async function postJson(
  node: DevnetNode,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

/** HTTP DELETE to a node API path (auth header + tolerant JSON parse), mirroring
 *  postJson. Extracted from pr1370's inline postDelete so DELETE-based teardown is
 *  a harness primitive; callers keep any path/param encoding domain-specific. */
export async function httpDelete(
  node: DevnetNode,
  path: string,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}${path}`, {
    method: 'DELETE',
    headers,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

/**
 * A single SPARQL result binding cell from the DKG daemon's /api/query. It arrives
 * either as an already-formatted N-Triples term STRING (`"v"@en`, `"v"^^<dt>`,
 * `<iri>`, `_:b`) or as a structured SPARQL-JSON object. Suites must NOT re-hedge
 * this union inline — route every cell through `normTerm` / `valueOf` / `lexical` /
 * `unwrapIri` below (the single typed boundary, per otReviewAgent #1397).
 */
export type SparqlBindingCell =
  | string
  | {
      value?: string;
      datatype?: string;
      type?: 'literal' | 'uri' | 'bnode' | string;
      'xml:lang'?: string;
      lang?: string;
    };

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/**
 * Normalize a binding cell to its full N-Triples object-term string, preserving the
 * datatype/lang suffix (the form the V10 leaf canon consumes). Idempotent on cells
 * already in term-string form; elides the redundant xsd:string datatype.
 */
export function normTerm(x: SparqlBindingCell | undefined | null): string {
  if (typeof x === 'string') return x;
  const o = x ?? {};
  if (o.value === undefined) return '';
  const lang = o['xml:lang'] ?? o.lang;
  if (lang) return `"${o.value}"@${lang}`;
  if (o.datatype && o.datatype !== XSD_STRING) return `"${o.value}"^^<${o.datatype}>`;
  if (o.type === 'uri' || o.type === 'bnode') return o.value;
  return /^["_<]/.test(o.value) ? o.value : `"${o.value}"`;
}

/** Bare string value of a cell (for IRI / non-literal columns that carry no suffix). */
export function valueOf(x: SparqlBindingCell | undefined | null): string {
  return typeof x === 'string' ? x : (x?.value ?? '');
}

/** Lexical form only: strip the surrounding quotes + any datatype/lang suffix. */
export function lexical(x: SparqlBindingCell | undefined | null): string {
  const t = valueOf(x);
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  return m ? m[1] : t;
}

/** Strip the surrounding `<…>` from an IRI term (→ bare URN/URI), else pass through. */
export function unwrapIri(x: SparqlBindingCell | undefined | null): string {
  const t = valueOf(x);
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
}

export interface QueryOpts {
  contextGraphId?: string;
  view?: string;
  subGraphName?: string;
}

/**
 * Run a SPARQL SELECT against a node (POST /api/query). The daemon body field
 * is `sparql` (NOT `query`). Returns the bindings array; each binding is a
 * `{ var: <n-triples-term-string> }` map (e.g. `{ name: '"Foo"' }`). THROWS on
 * an unrecognised 200 shape so a wrapper regression can't masquerade as 0 rows
 * (mirrors v10-core-flows `queryBindings`, otReviewAgent #1258).
 */
export async function queryNode(
  node: DevnetNode,
  sparql: string,
  opts: QueryOpts = {},
): Promise<Array<Record<string, SparqlBindingCell>>> {
  const body: Record<string, unknown> = { sparql };
  if (opts.contextGraphId) body.contextGraphId = opts.contextGraphId;
  if (opts.view) body.view = opts.view;
  if (opts.subGraphName) body.subGraphName = opts.subGraphName;
  const { status, json } = await postJson(node, '/api/query', body);
  if (status !== 200) {
    throw new Error(`query on node${node.num} failed (${status}): ${JSON.stringify(json)}`);
  }
  const bindings =
    json?.result?.bindings ?? // current daemon shape
    json?.results?.bindings ?? // SPARQL 1.1 JSON
    json?.bindings; // legacy flat
  if (!Array.isArray(bindings)) {
    throw new Error(
      `unrecognised /api/query response shape on node${node.num}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return bindings as Array<Record<string, SparqlBindingCell>>;
}

export async function waitFor<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}
