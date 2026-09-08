import type { ClientTarget } from '../src/mcp-client-registry.js';

declare const base: Pick<ClientTarget, 'id' | 'name' | 'location' | 'configPath' | 'displayPath'>;
const standard: ClientTarget = { ...base, format: 'json', serverContainer: 'mcpServers' };
const vscode: ClientTarget = { ...base, format: 'jsonc', serverContainer: 'servers' };
const codex: ClientTarget = { ...base, format: 'toml', serverContainer: 'mcp_servers' };
// @ts-expect-error Unsupported formats cannot enter registration operations.
const yaml: ClientTarget = { ...base, format: 'yaml', serverContainer: 'mcpServers' };
// @ts-expect-error Format and server container must be explicit.
const implicit: ClientTarget = base;
// @ts-expect-error TOML uses its own supported server container.
const wrongContainer: ClientTarget = { ...base, format: 'toml', serverContainer: 'servers' };
// @ts-expect-error Arbitrary server containers are not supported config shapes.
const arbitrary: ClientTarget = { ...base, format: 'json', serverContainer: 'unrelated.setting' };
void [standard, vscode, codex, yaml, implicit, wrongContainer, arbitrary];
