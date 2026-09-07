import type { ClientTarget } from '../src/mcp-client-registry.js';

declare const base: Pick<ClientTarget, 'id' | 'name' | 'location' | 'configPath' | 'displayPath'>;
const standard: ClientTarget = { ...base, format: 'json', entryPath: 'mcpServers.dkg' };
const vscode: ClientTarget = { ...base, format: 'json', entryPath: 'servers.dkg' };
const codex: ClientTarget = { ...base, format: 'toml', entryPath: 'mcp_servers.dkg' };
// @ts-expect-error Unsupported formats cannot enter registration operations.
const yaml: ClientTarget = { ...base, format: 'yaml', entryPath: 'mcpServers.dkg' };
// @ts-expect-error Format and owned entry path must be explicit.
const implicit: ClientTarget = base;
// @ts-expect-error TOML uses its own supported server container.
const wrongContainer: ClientTarget = { ...base, format: 'toml', entryPath: 'servers.dkg' };
// @ts-expect-error Arbitrary dotted paths are not supported config shapes.
const arbitrary: ClientTarget = { ...base, format: 'json', entryPath: 'unrelated.setting' };
void [standard, vscode, codex, yaml, implicit, wrongContainer, arbitrary];
