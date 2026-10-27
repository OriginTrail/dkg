/**
 * The buyer-gateway domain surface the daemon needs, as ONE pure module with
 * no runtime-root imports: the daemon's key store, gateway routes and Codex
 * OAuth flow import VALUES from
 * `@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js`, so
 * they (and their fast unit tests) never load the agent runtime. The agent
 * root re-exports it too.
 */
export {
  GatewayKeyLedger,
  SlidingWindowRateLimiter,
  GATEWAY_KEY_PREFIX,
  GATEWAY_KEY_PATTERN,
  publicGatewayKeyRecord,
  canonicalModelId,
  TOKENIZER_KINDS,
  isTokenizerKind,
  QUERY_MAX_SPARQL_BYTES,
  type GatewayKeyScopes,
  type GatewayKeyRecord,
  type PublicGatewayKeyRecord,
  type GatewayKeyLedgerJson,
  type GatewayKeyAuthVerdict,
  type GatewayKeyScopeVerdict,
  type TokenizerKind,
  type ChatToolCall,
  type ChatMeteringBlock,
  type QueryMeteringBlock,
  type RecountVerdict,
  type SellerStanding,
  type MeteringBasis,
} from '@origintrail-official/dkg-marketplace';
export {
  MarketplaceSpendRefusedError,
  MarketplaceRequestError,
  type MarketplaceSpendGuard,
} from './buyer-errors.js';
export {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_DEFAULT_BASE,
  CODEX_TOKEN_URL,
  defaultCodexAuthFile,
} from './connectors/codex-constants.js';
