import type { ClientTarget, McpConfigSelection } from '../src/mcp-client-registry.js';

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

// Mutation requires a selected physical config; a logical target cannot bypass it.
import { readRegisteredServerKeys, writeRegistration, removeRegistration } from '../src/mcp-client-config.js';
import type { McpPhysicalConfig } from '../src/mcp-physical-config.js';
declare const selection: McpConfigSelection;
declare const registration: Parameters<typeof writeRegistration>[1];
const file: McpPhysicalConfig = selection.file;
const selectedClient: ClientTarget | undefined = selection.aliases[0];
writeRegistration(selection.file, registration);
removeRegistration(selection.file);
readRegisteredServerKeys(selection.file);
// @ts-expect-error Readers also require a selected physical config.
readRegisteredServerKeys(standard);
// @ts-expect-error A raw logical target cannot bypass destination ownership.
writeRegistration(standard, registration);
// @ts-expect-error Removal also requires the physical mutation boundary.
removeRegistration(standard);
// @ts-expect-error Physical configs carry no synthesized logical location.
const location = selection.file.location;
// @ts-expect-error A physical config is not a logical client.
const identity: ClientTarget = selection.file;
void [file, selectedClient, location, identity];
