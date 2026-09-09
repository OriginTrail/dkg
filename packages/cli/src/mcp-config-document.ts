/** DKG owns one fixed server entry inside each client's declared container. */
export const DKG_SERVER_KEY = 'dkg';
export type McpClientConfigShape =
  | { readonly format: 'json'; readonly serverContainer: 'mcpServers' | 'servers' }
  | { readonly format: 'jsonc'; readonly serverContainer: 'servers' }
  | { readonly format: 'toml'; readonly serverContainer: 'mcp_servers' };

/** Canonical fields owned by `dkg mcp setup`. */
export interface DesiredRegistration {
  command: string;
  args: string[];
  env: { DKG_HOME: string };
}
/** Persisted client shape at the single extension-preserving merge boundary. */
export interface PersistedRegistration {
  command: string;
  args: string[];
  env: { DKG_HOME: string; [name: string]: unknown };
  [name: string]: unknown;
}

export type RegistrationEdit =
  | { kind: 'remove' }
  | { kind: 'upsert'; registration: PersistedRegistration };

export interface McpDocumentEditResult {
  content: string;
  warning?: string;
}

/** Formats transform source snapshots; the coordinator owns all filesystem effects. */
export interface McpConfigDocumentAdapter {
  parse(source: string): Record<string, unknown>;
  applyEdit(
    source: string,
    body: Record<string, unknown>,
    edit: RegistrationEdit,
    serverContainer: McpClientConfigShape['serverContainer'],
  ): McpDocumentEditResult;
}
