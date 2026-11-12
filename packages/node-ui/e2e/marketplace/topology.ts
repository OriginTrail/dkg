/**
 * The NeuroSymbolic Marketplace devnet (OT-RFC-27) that
 * `playwright.marketplace.config.ts` boots: which node sells, which buys and
 * which runs without the marketplace, the services the seller offers on the
 * stub backend, and the ports the lane uses. The config, the setup and the
 * specs all read it, so they agree on one topology.
 *
 * The ports differ from the default suite's (Hardhat 8545, APIs from 19201,
 * libp2p from 20001, Oxigraph from 7900, Vite 5173), and each can be moved
 * with the environment variable beside it. The devnet directory is the same:
 * both lanes keep their devnet in the repository's `.devnet`, which the node
 * UI's Vite config reads, so run one lane at a time in a checkout (see
 * `DEVNET_DIR` in devnet.ts). CI runs each lane on its own runner.
 */
import { keccak256, stringToBytes } from 'viem';

const portOf = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a port number, not "${raw}"`);
  return port;
};

export const PORTS = {
  hardhat: portOf('MKT_E2E_HARDHAT_PORT', 8645),
  apiBase: portOf('MKT_E2E_API_PORT_BASE', 19301),
  libp2pBase: portOf('MKT_E2E_LIBP2P_PORT_BASE', 20101),
  oxigraphBase: portOf('MKT_E2E_OXIGRAPH_BASE', 7950),
  blazegraph: portOf('MKT_E2E_BLAZEGRAPH_PORT', 10099),
  stub: portOf('MKT_E2E_STUB_PORT', 18555),
  buyerUi: portOf('MKT_E2E_BUYER_UI_PORT', 5181),
  sellerUi: portOf('MKT_E2E_SELLER_UI_PORT', 5182),
  plainUi: portOf('MKT_E2E_PLAIN_UI_PORT', 5183),
} as const;

/** Docker containers (Blazegraph for nodes 3 and 4) carry this prefix, apart from the default suite's `devnet-*`. */
export const DOCKER_NAME_PREFIX = process.env.MKT_E2E_DOCKER_NAME_PREFIX || 'devnet-marketplace';

/**
 * Four Core Nodes, as the default suite boots them: a Verifiable Memory
 * publish needs three StorageACKs. Node 1 is the relay hub and creates the
 * Marketplace Context Graph; node 2 sells; node 3 buys; node 4 runs without
 * the marketplace. Only the seller and the buyer restart, after the graph is
 * registered, so the hub keeps its links.
 */
export const NUM_NODES = 4;
export const NODES = { owner: 1, seller: 2, buyer: 3, plain: 4 } as const;

/** The Marketplace Context Graph: registered on chain, public (access policy 0), open publishing (publish policy 1). */
export const MARKETPLACE_CG = {
  id: 'devnet-marketplace',
  name: 'NeuroSymbolic Marketplace (devnet)',
  description: 'Offers of the devnet sellers (OT-RFC-27)',
  accessPolicy: 0,
  publishPolicy: 1,
} as const;

/** What the stub backend answers, and the tokens it counts for each call: 9 in and 6 out. */
export const STUB_PROMPT_TOKENS = 9;
export const STUB_COMPLETION_TOKENS = 6;
export const STUB_UNITS = STUB_PROMPT_TOKENS + STUB_COMPLETION_TOKENS;
export const stubAnswerOf = (backendModel: string): string => `Deterministic answer from ${backendModel}.`;

export interface MarketplaceService {
  /** The model's URN; its keccak256 is the service id. */
  model: string;
  /** The model's name, as the UI shows it: the URN after its last colon. */
  name: string;
  /** The stub's own name for it. */
  backendModel: string;
  /** Wei per token. */
  pricePerUnit: bigint;
  serviceId: string;
}

function service(model: string, backendModel: string, pricePerUnit: bigint): MarketplaceService {
  return {
    model,
    name: model.slice(model.lastIndexOf(':') + 1),
    backendModel,
    pricePerUnit,
    serviceId: keccak256(stringToBytes(model)),
  };
}

/**
 * The seller's two services. Prices are chosen so that what one call costs
 * shows at the UI's four decimal places: 15 tokens at 200 µTRAC a token is
 * 0.003 TRAC, at 500 µTRAC 0.0075 TRAC.
 */
export const CHAT = service('urn:dkg:model:devnet:stub-chat', 'stub-chat', 200_000_000_000_000n);
export const REASONER = service('urn:dkg:model:devnet:stub-reasoner', 'stub-reasoner', 500_000_000_000_000n);
export const SERVICES = [CHAT, REASONER] as const;

/**
 * The plan the Plans spec composes for this epoch: one TRAC for the chat
 * service, and so little for the reasoner that its first call meets the soft
 * ceiling. A call holds what it could cost at most (its input bound and 512
 * output tokens at the price, about 0.27 TRAC here), over 95% of 0.05 TRAC. The
 * top-up spec then raises the reasoner's budget by one TRAC.
 */
export const PLAN = { chatTrac: '1', reasonerTrac: '0.05', topUpTrac: '1' } as const;

/**
 * The Conviction Account the account spec opens from the buyer node's wallet:
 * 100,000 TRAC committed, the tier with 30% off (PublishingMathLib).
 */
export const ACCOUNT = { committedTrac: '100000', discountBps: 3_000 } as const;

/**
 * The seller's landing interval on this lane: a year, longer than the devnet's
 * epoch, so no regular landing time falls inside the epoch. Before the last
 * stretch only Land now lands a receipt, and what lands by itself in the
 * epoch-close spec is the last stretch's doing.
 */
export const LANDING_INTERVAL_MINUTES = 365 * 24 * 60;

/**
 * An access key's id: its secret's `dkgmk_` prefix and the first
 * `ACCESS_KEY_ID_HEX` hex digits after it, 64 bits. This mirrors `KEY_ID_HEX`
 * in packages/marketplace/src/keys.ts (keys made with the earlier 8-digit ids
 * keep them; the lane makes new ones). The Access page names each key's row
 * by this id and shows it as the key's prefix.
 */
export const ACCESS_KEY_PREFIX = 'dkgmk_';
export const ACCESS_KEY_ID_HEX = 16;
export const accessKeyIdOf = (secret: string): string => secret.slice(0, ACCESS_KEY_PREFIX.length + ACCESS_KEY_ID_HEX);

/** The chat service's price for the next epoch, which the next-price spec sets on Operate: 150 µTRAC a token. */
export const NEXT_CHAT_PRICE = 150_000_000_000_000n;

export const WEI_PER_TRAC = 10n ** 18n;

/** Wei from a TRAC amount written as the specs write it (`1`, `0.05`). */
export function weiOfTrac(trac: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(trac)) throw new Error(`not a TRAC amount: ${trac}`);
  const [whole, frac = ''] = trac.split('.');
  return BigInt(whole) * WEI_PER_TRAC + BigInt(frac.padEnd(18, '0'));
}

/** `0.003` from wei: four places at most, as the UI shows TRAC. */
export function tracOf(wei: bigint): string {
  const whole = wei / WEI_PER_TRAC;
  const frac = (wei % WEI_PER_TRAC).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** `200` from wei per token: µTRAC a token, as the UI shows prices. */
export function microOf(weiPerUnit: bigint): string {
  const scale = 10n ** 12n;
  const whole = weiPerUnit / scale;
  const frac = (weiPerUnit % scale).toString().padStart(12, '0').slice(0, 4).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** What one stub call costs on a service, in wei. */
export const callValueOf = (s: MarketplaceService): bigint => BigInt(STUB_UNITS) * s.pricePerUnit;

/** The UI origins: the buyer node's, the seller node's and the plain node's, each a Vite server proxying `/api` to its node. */
export const UI = {
  buyer: `http://127.0.0.1:${PORTS.buyerUi}/ui/`,
  seller: `http://127.0.0.1:${PORTS.sellerUi}/ui/`,
  plain: `http://127.0.0.1:${PORTS.plainUi}/ui/`,
} as const;
