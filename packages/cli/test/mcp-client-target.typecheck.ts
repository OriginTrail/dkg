import type { ClientTarget } from '../src/mcp-client-registry.js';

declare const paths: Pick<ClientTarget, 'name' | 'configPath' | 'displayPath'>;
const standard: ClientTarget = { ...paths, id: 'cursor', location: 'native', format: 'json', serverContainer: 'mcpServers' };
const vscode: ClientTarget = { ...paths, id: 'vscode', location: 'windows-wsl', format: 'jsonc', serverContainer: 'servers' };
const codex: ClientTarget = { ...paths, id: 'codex-cli', location: 'native', format: 'toml', serverContainer: 'mcp_servers' };
// @ts-expect-error A Codex target cannot carry another client's JSONC shape.
const wrongCodex: ClientTarget = { ...vscode, id: 'codex-cli' };
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
