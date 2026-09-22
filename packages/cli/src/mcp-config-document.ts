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

/** Parsed config objects have named fields; arrays/scalars are never records. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The semantic edit shared by format adapters; the parsed source stays untouched. */
export function applyRegistrationEditToBody(
  body: Record<string, unknown>,
  edit: RegistrationEdit,
  serverContainer: McpClientConfigShape['serverContainer'],
): Record<string, unknown> {
  const current = Object.hasOwn(body, serverContainer) ? body[serverContainer] : {};
  if (!isPlainRecord(current)) throw new Error('Malformed MCP server container');
  if (edit.kind === 'remove' && !Object.hasOwn(current, DKG_SERVER_KEY)) return body;
  const container = { ...current };
  if (edit.kind === 'remove') delete container[DKG_SERVER_KEY];
  else container[DKG_SERVER_KEY] = edit.registration;
  return { ...body, [serverContainer]: container };
}

export interface McpDocumentEditResult {
  content: string;
  warning?: string;
}

/** Formats transform source snapshots; the coordinator owns all filesystem effects. */
export interface McpConfigDocumentAdapter {
  parse(source: string): Record<string, unknown>;
  applyEdit(
    source: string,
    edit: RegistrationEdit,
    serverContainer: McpClientConfigShape['serverContainer'],
  ): McpDocumentEditResult;
}
