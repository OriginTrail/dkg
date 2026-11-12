/**
 * The marketplace lane's devnet (OT-RFC-27), chained into the buyer UI's web
 * server command in `playwright.marketplace.config.ts`, before Vite reads the
 * buyer's `api.port`:
 *   1. a fresh four-node devnet on the lane's ports, through the default
 *      suite's bootstrap (its ownership marker lets the teardown stop it). A
 *      devnet already up on these ports is refused: the specs fund this
 *      epoch's first subscription, which a reused chain may hold already.
 *      MKT_E2E_REUSE_DEVNET=1 reuses one anyway, for work on one spec;
 *   2. the Marketplace Context Graph, created and registered on chain by
 *      node 1 as a public graph with open publishing, and checked on chain;
 *   3. the seller (node 2, a Core Node) and the buyer (node 3) configured for
 *      the marketplace and restarted, seller first, once the graph is
 *      registered, so each is admitted when it starts. Node 4 keeps no
 *      marketplace;
 *   4. the buyer wallet funded with ETH and TRAC when it has too little;
 *   5. the buyer's catalog listing the seller's two services: the lane's
 *      readiness, read through the API, however the offers travel.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';
import type { CatalogAnswer, Funding, SellerStatus } from '../../src/ui/marketplace/api/types.js';
import { bootstrapDevnet } from '../bootstrap-devnet-runtime.js';
import {
  DEVNET_DIR, REPO_ROOT, SETUP_FILE, chainUp, contextGraphOnChain, devnetEnv, fundWallet, nodeCall, nodeOk,
  nodeUp, statusOf, waitFor, type MarketplaceSetup,
} from './devnet.js';
import { LANDING_INTERVAL_MINUTES, MARKETPLACE_CG, NODES, NUM_NODES, PORTS, SERVICES, WEI_PER_TRAC } from './topology.js';

const log = (message: string) => console.log(`[marketplace-setup] ${message}`);

/** The default suite's devnet script, which this lane drives with its own ports. */
const DEVNET_SH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/devnet.sh');

function runDevnet(args: string[]): Promise<number> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('bash', [DEVNET_SH, ...args], { cwd: REPO_ROOT, env: devnetEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', rejectRun);
    child.on('exit', (code) => resolveRun(typeof code === 'number' ? code : 1));
  });
}

// ── 1. the devnet ───────────────────────────────────────────────────────────

async function devnetAlreadyUp(): Promise<string[]> {
  const up: string[] = [];
  if (await chainUp()) up.push(`Hardhat on :${PORTS.hardhat}`);
  for (let n = 1; n <= NUM_NODES; n++) if (await nodeUp(n)) up.push(`node${n}`);
  return up;
}

async function startDevnet(): Promise<void> {
  const up = await devnetAlreadyUp();
  if (up.length > 0 && process.env.MKT_E2E_REUSE_DEVNET !== '1') {
    throw new Error(
      `a devnet is already up on the marketplace lane's Hardhat port or in ${DEVNET_DIR} (${up.join(', ')}). The specs fund this epoch's first ` +
      'subscription, which a reused chain may hold already, so the lane starts its own. Stop it with ' +
      `\`DEVNET_DIR=${DEVNET_DIR} HARDHAT_PORT=${PORTS.hardhat} API_PORT_BASE=${PORTS.apiBase} ` +
      `DEVNET_DOCKER_NAME_PREFIX=${devnetEnv().DEVNET_DOCKER_NAME_PREFIX} bash scripts/devnet.sh stop\`, ` +
      'or set MKT_E2E_REUSE_DEVNET=1 to run against it anyway.',
    );
  }
  await bootstrapDevnet({
    devnetDir: DEVNET_DIR,
    nodeNum: String(NODES.owner),
    numNodes: String(NUM_NODES),
    timeoutMs: Number(process.env.PLAYWRIGHT_DEVNET_TIMEOUT_MS) || 300_000,
    apiPortBase: String(PORTS.apiBase),
    libp2pPortBase: String(PORTS.libp2pBase),
    launch: async () => ({ exitCode: await runDevnet(['start', String(NUM_NODES)]) }),
  });
}

// ── 2. the Marketplace Context Graph ────────────────────────────────────────

interface ContextGraphRow { id: string; onChainId?: string | number | null }

const contextGraphsOf = async (nodeNum: number) =>
  (await nodeOk<{ contextGraphs: ContextGraphRow[] }>(nodeNum, 'GET', '/api/context-graph/list')).contextGraphs;

/** The on-chain id node 1 holds for the graph it created. */
async function onChainIdSeenBy(nodeNum: number): Promise<string | undefined> {
  const row = (await contextGraphsOf(nodeNum)).find((g) => g.id === MARKETPLACE_CG.id);
  return row?.onChainId ? String(row.onChainId) : undefined;
}

async function registerGraph(): Promise<string> {
  const { id, name, description, accessPolicy, publishPolicy } = MARKETPLACE_CG;
  const created = await nodeCall<{ registered?: boolean; onChainId?: string | number; registerError?: string; error?: string }>(
    NODES.owner, 'POST', '/api/context-graph/create', { id, name, description, accessPolicy, publishPolicy, register: true },
  );
  if (created.status === 200) {
    if (created.body.registered !== true || created.body.onChainId === undefined) {
      throw new Error(`node${NODES.owner} created "${id}" but did not register it on chain: ${created.body.registerError ?? JSON.stringify(created.body)}`);
    }
    return String(created.body.onChainId);
  }
  if (created.status !== 409) throw new Error(`node${NODES.owner} could not create "${id}": ${created.status} ${JSON.stringify(created.body)}`);
  // A reused devnet: the graph exists on node 1; register it unless it is registered already.
  const registered = await nodeCall<{ onChainId?: string | number; error?: string }>(NODES.owner, 'POST', '/api/context-graph/register', { id, accessPolicy, publishPolicy });
  if (registered.status === 200 && registered.body.onChainId !== undefined) return String(registered.body.onChainId);
  const known = await onChainIdSeenBy(NODES.owner);
  if (known) return known;
  throw new Error(`"${id}" exists on node${NODES.owner} but is not registered: ${registered.status} ${JSON.stringify(registered.body)}`);
}

async function ensureGraph(): Promise<string> {
  const onChainId = await registerGraph();
  const onChain = await contextGraphOnChain(BigInt(onChainId));
  if (!onChain.active || onChain.accessPolicy !== MARKETPLACE_CG.accessPolicy || onChain.publishPolicy !== MARKETPLACE_CG.publishPolicy) {
    throw new Error(`"${MARKETPLACE_CG.id}" (on chain ${onChainId}) is not an active public graph with open publishing: ${JSON.stringify(onChain)}`);
  }
  log(`"${MARKETPLACE_CG.id}" is registered on chain as ${onChainId}: public, open publishing`);
  // The other nodes find the registration on chain, listed by its name hash until they learn the name. Admission
  // reads the chain itself, so a node that has not found it yet is admitted all the same: this wait only reports.
  for (const nodeNum of [NODES.seller, NODES.buyer]) {
    try {
      await waitFor(`node${nodeNum} to find graph ${onChainId} on chain`, async () =>
        (await contextGraphsOf(nodeNum)).some((g) => String(g.onChainId ?? '') === onChainId), 30_000);
      log(`node${nodeNum} lists graph ${onChainId}`);
    } catch {
      log(`node${nodeNum} does not list graph ${onChainId} yet; its admission reads the chain`);
    }
  }
  return onChainId;
}

// ── 3. the seller and the buyer ─────────────────────────────────────────────

/**
 * The seller's and the buyer's `marketplace` blocks. Ticks are short so the
 * specs see a tick's work within seconds. The landing loop keeps its defaults
 * but four: Hardhat's base fee is above the shipped ceilings, a receipt lands
 * at once rather than 30 s after it completed, no budget lands by itself for
 * being near its limit, and no regular landing time falls inside the epoch
 * (`LANDING_INTERVAL_MINUTES`). So the receipts wait for Land now, or for the
 * epoch's last stretch.
 */
function marketplaceBlockOf(nodeNum: number): Record<string, unknown> {
  const common = { enabled: true, contextGraphId: MARKETPLACE_CG.id, tickSeconds: 10 };
  if (nodeNum !== NODES.seller) return common;
  return {
    ...common,
    seller: {
      enabled: true,
      tickSeconds: 10,
      services: SERVICES.map((s) => ({
        model: s.model,
        pricePerUnit: s.pricePerUnit.toString(),
        capacity: 4,
        backend: { kind: 'llamacpp', baseUrl: `http://127.0.0.1:${PORTS.stub}/v1`, model: s.backendModel },
      })),
      landing: {
        landingIntervalMinutes: LANDING_INTERVAL_MINUTES,
        baseFeeCeilingGwei: 1_000,
        lastStretchBaseFeeCeilingGwei: 1_000,
        completedMarginSeconds: 0,
        nearLimitShare: 0,
      },
    },
  };
}

/** Write the node's marketplace block and restart it; a node that has it already is left running. */
async function configureNode(nodeNum: number): Promise<void> {
  const file = resolve(DEVNET_DIR, `node${nodeNum}`, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const wanted = marketplaceBlockOf(nodeNum);
  if (JSON.stringify(config.marketplace) === JSON.stringify(wanted)) {
    log(`node${nodeNum} already has its marketplace settings`);
    return;
  }
  writeFileSync(file, `${JSON.stringify({ ...config, marketplace: wanted }, null, 2)}\n`);
  log(`node${nodeNum}: marketplace settings written; restarting it`);
  const exitCode = await runDevnet(['restart-node', String(nodeNum)]);
  if (exitCode !== 0) throw new Error(`scripts/devnet.sh restart-node ${nodeNum} exited ${exitCode}`);
  await waitFor(`node${nodeNum} to answer after its restart`, () => nodeUp(nodeNum), 180_000);
}

async function waitForMesh(): Promise<void> {
  const expected = NUM_NODES - 1;
  await waitFor(`node${NODES.owner} to see its ${expected} peers again`, async () => ((await statusOf(NODES.owner)).connectedPeers ?? 0) >= expected, 180_000);
  await waitFor(`the buyer (node${NODES.buyer}) to see the seller's peer`, async () => ((await statusOf(NODES.buyer)).connectedPeers ?? 0) >= 2, 120_000);
}

// ── 4. the buyer wallet ─────────────────────────────────────────────────────

const ENOUGH_ETH = 10n ** 18n;
const ENOUGH_TRAC = 1_000n * WEI_PER_TRAC;

async function fundBuyer(): Promise<string> {
  const funding = await waitFor('the buyer\'s marketplace to answer /funding', async () => {
    const answer = await nodeCall<Funding>(NODES.buyer, 'GET', '/api/marketplace/funding');
    if (answer.status !== 200) throw new Error(`${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  }, 120_000);
  const wallet = funding.buyerWallet;
  const eth = BigInt(wallet.eth);
  const trac = BigInt(wallet.trac);
  if (eth < ENOUGH_ETH || trac < ENOUGH_TRAC) {
    log(`buyer wallet ${wallet.address} holds ${wallet.ethEther} ETH and ${wallet.tracTrac} TRAC: funding it`);
    await fundWallet(wallet.address as Address, {
      ...(eth < ENOUGH_ETH ? { ethWei: 100n * ENOUGH_ETH } : {}),
      ...(trac < ENOUGH_TRAC ? { tracWei: 1_000_000n * WEI_PER_TRAC } : {}),
    });
  }
  const after = await nodeOk<Funding>(NODES.buyer, 'GET', '/api/marketplace/funding');
  if (BigInt(after.buyerWallet.eth) < ENOUGH_ETH || BigInt(after.buyerWallet.trac) < ENOUGH_TRAC) {
    throw new Error(`the buyer wallet is still short after funding: ${JSON.stringify(after.buyerWallet)}`);
  }
  log(`buyer wallet ${after.buyerWallet.address}: ${after.buyerWallet.ethEther} ETH, ${after.buyerWallet.tracTrac} TRAC`);
  return after.buyerWallet.address;
}

// ── 5. ready: the buyer's catalog lists the seller ──────────────────────────

async function waitForCatalog(sellerIdentity: number): Promise<void> {
  try {
    await waitFor('the buyer\'s catalog to list both services from the seller', async () => {
      const answer = await nodeCall<CatalogAnswer>(NODES.buyer, 'GET', '/api/marketplace/catalog');
      if (answer.status !== 200) throw new Error(`${answer.status} ${JSON.stringify(answer.body)}`);
      return SERVICES.every((s) => answer.body.services.some((c) => c.serviceId === s.serviceId && c.offers.some((o) => o.seller === sellerIdentity)));
    }, Number(process.env.MKT_E2E_CATALOG_TIMEOUT_MS) || 300_000, 3_000);
  } catch (err) {
    const catalog = await nodeCall(NODES.buyer, 'GET', '/api/marketplace/catalog').catch((e: unknown) => ({ status: 0, body: String(e) }));
    const seller = await nodeCall(NODES.seller, 'GET', '/api/marketplace/seller').catch((e: unknown) => ({ status: 0, body: String(e) }));
    log(`buyer catalog: ${JSON.stringify(catalog)}`);
    log(`seller status: ${JSON.stringify(seller)}`);
    for (const nodeNum of [NODES.seller, NODES.buyer]) {
      const lines = readFileSync(resolve(DEVNET_DIR, `node${nodeNum}`, 'daemon.log'), 'utf8').split('\n').filter((l) => l.includes('[marketplace]'));
      log(`node${nodeNum} [marketplace] log:\n${lines.slice(-20).join('\n')}`);
    }
    throw err;
  }
  log('the buyer\'s catalog lists both services from the seller');
}

async function main(): Promise<void> {
  const started = Date.now();
  await startDevnet();
  const onChainId = await ensureGraph();
  await configureNode(NODES.seller);
  await configureNode(NODES.buyer);
  await waitForMesh();
  const seller = await waitFor('the seller\'s Operate to answer', async () => {
    const answer = await nodeCall<SellerStatus>(NODES.seller, 'GET', '/api/marketplace/seller');
    if (answer.status !== 200) throw new Error(`${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  }, 120_000);
  const sellerStatus = await statusOf(NODES.seller);
  const wallet = await fundBuyer();
  await waitForCatalog(seller.identityId);
  const setup: MarketplaceSetup = {
    contextGraphId: MARKETPLACE_CG.id,
    onChainId,
    seller: { node: NODES.seller, identityId: seller.identityId, peerId: sellerStatus.peerId ?? '' },
    buyer: { node: NODES.buyer, wallet },
    plain: { node: NODES.plain },
  };
  writeFileSync(SETUP_FILE, `${JSON.stringify(setup, null, 2)}\n`);
  log(`ready in ${Math.round((Date.now() - started) / 1000)} s: seller ${seller.identityId} (node${NODES.seller}), buyer node${NODES.buyer}, plain node${NODES.plain}`);
}

main().catch((err: unknown) => {
  console.error('[marketplace-setup] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
