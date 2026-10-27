/**
 * `mountChatConnector` — the one entry point from connector config to a live
 * `ChatConnector`. Mount checks spend nothing upstream except llama.cpp's
 * loopback `/v1/models` probe; failures throw `MarketplaceConnectorMountError`.
 */
import type { MarketplaceConnectorConfig } from '../config.js';
import type { MarketplaceLogger } from '../seller-service.js';
import { mountCodexOAuthConnector } from './codex-oauth.js';
import { mountLlamaCppConnector } from './llamacpp.js';
import { mountOpenAiCompatibleConnector } from './openai-compatible.js';
import type { ChatConnector } from './types.js';
import { MarketplaceConnectorMountError } from './types.js';

export interface ChatConnectorMountDeps {
  dataDir?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log: MarketplaceLogger;
  /** Test seam: the codex OAuth token endpoint. */
  codexTokenUrl?: string;
  /** Test seam: the GGUF hasher (llamacpp). */
  hashFile?: (path: string) => Promise<string>;
}

export async function mountChatConnector(
  config: MarketplaceConnectorConfig,
  deps: ChatConnectorMountDeps,
): Promise<ChatConnector> {
  switch (config?.kind) {
    case 'openai-compatible':
      return mountOpenAiCompatibleConnector(config, deps);
    case 'llamacpp':
      return mountLlamaCppConnector(config, deps);
    case 'codex-oauth':
      return mountCodexOAuthConnector(config, deps);
    default:
      throw new MarketplaceConnectorMountError(
        'CONNECTOR_CONFIG',
        `connector.kind must be openai-compatible, llamacpp or codex-oauth (got ${JSON.stringify((config as { kind?: unknown } | undefined)?.kind)})`,
      );
  }
}

export type { ChatConnector, ChatConnectorKind, ConnectorChatOutcome, ConnectorChatRequest, ConnectorDescription } from './types.js';
export { MarketplaceConnectorMountError } from './types.js';
export { CODEX_DEFAULT_BASE, CODEX_OAUTH_CLIENT_ID, CODEX_TOKEN_URL, defaultCodexAuthFile } from './codex-constants.js';
