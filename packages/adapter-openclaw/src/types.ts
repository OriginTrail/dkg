/**
 * Minimal OpenClaw plugin API types.
 *
 * These mirror the OpenClaw runtime API surface that plugins interact with.
 * The full types live in the OpenClaw runtime; these are the subset needed
 * to build a DKG adapter plugin.
 */

export interface OpenClawPluginApi {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registerTool(tool: OpenClawTool): void;
  registerHook(event: string, handler: (...args: any[]) => Promise<void>, opts?: { name: string }): void;
  on(event: string, handler: (...args: any[]) => void): void;
  logger: { info?(...args: any[]): void; warn?(...args: any[]): void; debug?(...args: any[]): void };
}

export interface OpenClawTool {
  name: string;
  description: string;
  parameters: JSONSchemaObject;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<OpenClawToolResult>;
}

export interface JSONSchemaObject {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface OpenClawToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
}

export interface DkgOpenClawConfig {
  /** Persistent identity / state directory. Default: `.dkg/openclaw` */
  dataDir?: string;
  /** DKG listen port. Default: random */
  listenPort?: number;
  /** Relay peer multiaddrs for NAT traversal. */
  relayPeers?: string[];
  /** Bootstrap peer multiaddrs. */
  bootstrapPeers?: string[];
  /** Agent display name (defaults to OpenClaw agent name). */
  name?: string;
  /** Agent description. */
  description?: string;
  /** On-chain config (private key via DKG_EVM_PRIVATE_KEY env var). */
  chainConfig?: {
    rpcUrl?: string;
    hubAddress?: string;
    privateKey?: string;
  };
  /** Skills this agent offers. */
  skills?: Array<{
    skillType: string;
    pricePerCall?: number;
    currency?: string;
    handler: (input: Uint8Array) => Promise<{ status: string; output?: Uint8Array; error?: string }>;
  }>;
}
