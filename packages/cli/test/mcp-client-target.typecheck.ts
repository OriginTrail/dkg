import type { ClientTarget, McpConfigEndpoint, McpConfigSelection } from '../src/mcp-client-registry.js';

declare const paths: Pick<ClientTarget, 'name' | 'configPath' | 'displayPath'>;
const standard: ClientTarget = { ...paths, id: 'cursor', location: 'native', format: 'json', serverContainer: 'mcpServers' };
const vscode: ClientTarget = { ...paths, id: 'vscode', location: 'windows-wsl', format: 'jsonc', serverContainer: 'servers' };
const codex: ClientTarget = { ...paths, id: 'codex-cli', location: 'native', format: 'toml', serverContainer: 'mcp_servers' };
// @ts-expect-error A Codex target cannot carry another client's JSONC shape.
const wrongCodex: ClientTarget = { ...vscode, id: 'codex-cli', location: 'native' };
// @ts-expect-error Cursor's identity determines its JSON mcpServers container.
const wrongCursor: ClientTarget = { ...codex, id: 'cursor' };
// @ts-expect-error Codex has no Windows-side WSL registration target.
const unsupportedCodexLocation: ClientTarget = { ...codex, location: 'windows-wsl' };
// @ts-expect-error Claude Code has no Windows-side WSL registration target.
const unsupportedClaudeLocation: ClientTarget = { ...standard, id: 'claude-code', location: 'windows-wsl' };
// @ts-expect-error Format and container must be explicit.
const implicit: ClientTarget = { ...paths, id: 'cursor', location: 'native' };
// @ts-expect-error Arbitrary server containers are not supported.
const arbitrary: ClientTarget = { ...standard, serverContainer: 'unrelated.setting' };
void [standard, vscode, codex, wrongCodex, wrongCursor, unsupportedCodexLocation, unsupportedClaudeLocation, implicit, arbitrary];

// Physical persistence and selected logical identities are separate contracts.
declare const selection: McpConfigSelection;
const endpoint: McpConfigEndpoint = selection.endpoint;
const selectedClient: ClientTarget | undefined = selection.aliases[0];
// @ts-expect-error A physical endpoint does not represent a logical client.
const identity: ClientTarget = selection.endpoint;
// @ts-expect-error Client identity is not available on the persistence endpoint.
const endpointId = selection.endpoint.id;
void [endpoint, selectedClient, identity, endpointId];
