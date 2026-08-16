// Marketplace configuration. Read from `<dkgHome>/marketplace/config.json` so the
// host config schema needs no marketplace-specific keys — the only core coupling
// is the routePlugins entry that loads this plugin at all.
//
// `enabled` defaults to FALSE: with the flag off the plugin's handle() returns
// without touching the response, so every marketplace route is ABSENT (404 from
// the daemon's fallthrough), not merely forbidden.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LlamaCppConnectorConfig {
  kind: "llamacpp";
  /** loopback base of the llama.cpp server, e.g. http://127.0.0.1:8080 */
  baseUrl: string;
  /** absolute path of the GGUF being served — hashed at connect time */
  ggufPath: string;
  /** absolute path of the tokenizer bundle dir (tokenizer.json etc.) */
  tokenizerDir: string;
  /** deterministic serving settings, recorded in the offering */
  settings: { seed: number; temperature: number; ctx: number };
}

export interface OpenAiConnectorConfig {
  kind: "openai";
  /** upstream base, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** upstream model string, e.g. gpt-4o-mini */
  model: string;
  /** env file inside the SECRET STORE holding OPENAI_API_KEY; never in this config */
  secretEnvFile: string;
  /** public tokenizer bundle name for count verification, e.g. o200k_base */
  tokenizerBundle: string;
}

export interface OfferingConfig {
  id: string;                       // stable local id, e.g. "qwen25-14b"
  provenanceClass: "weights-pinned" | "upstream-claimed";
  connector: LlamaCppConnectorConfig | OpenAiConnectorConfig;
  perInputTokenMicroTrac: number;
  perOutputTokenMicroTrac: number;
  queryFlatMicroTrac: number;
  perReturnedQuadMicroTrac: number;
}

export interface MarketplaceConfig {
  enabled: boolean;
  /** seller payout address (defaults to the node's operational wallet — CP1) */
  providerAddress?: string;
  /** externally reachable base of THIS seller's public front (goes in the offering KA) */
  apiBase?: string;
  offerings: OfferingConfig[];
  /** chain id the deposit rail verifies against (8453 Base mainnet; testnet per network) */
  chainId?: number;
  /** Base RPC the SELLER uses to verify deposits — its own view, never the buyer's */
  rpcUrl?: string;
}

const DEFAULTS: MarketplaceConfig = { enabled: false, offerings: [] };

export function marketplaceHome(dkgHome: string): string {
  return join(dkgHome, "marketplace");
}

export function loadMarketplaceConfig(dkgHome: string): MarketplaceConfig {
  const p = join(marketplaceHome(dkgHome), "config.json");
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<MarketplaceConfig>;
    return {
      enabled: raw.enabled === true,           // strict: anything else is off
      providerAddress: typeof raw.providerAddress === "string" ? raw.providerAddress : undefined,
      apiBase: typeof raw.apiBase === "string" ? raw.apiBase : undefined,
      offerings: Array.isArray(raw.offerings) ? (raw.offerings as OfferingConfig[]) : [],
      chainId: typeof raw.chainId === "number" ? raw.chainId : undefined,
      rpcUrl: typeof raw.rpcUrl === "string" ? raw.rpcUrl : undefined,
    };
  } catch {
    // malformed config ⇒ marketplace OFF, never a half-configured surface
    return { ...DEFAULTS };
  }
}
