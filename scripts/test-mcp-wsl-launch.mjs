#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Run inside real WSL; a Windows Node client applies the persisted MCP environment
// before launching the registered wsl.exe command and the production Linux server.
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function runWindowsMcpSmoke(configPath, windowsNode, expectedProject, expectedApiPort, runtime = {}) {
  const { platform = process.platform, env = process.env, execute = execFileSync } = runtime;
  if (platform !== 'linux' || !env.WSL_DISTRO_NAME) {
    throw new Error('This smoke test requires a real WSL distribution with Windows interop enabled.');
  }
  if (!configPath || !windowsNode) {
    throw new Error('Usage: node scripts/test-mcp-wsl-launch.mjs <client-config> <Windows-node.exe> [expected-project] [expected-api-port]');
  }
  const convert = (flag, value) => execute('/usr/bin/wslpath', [flag, value], { encoding: 'utf8' }).trim();
  const driver = fileURLToPath(new URL('../packages/cli/test/fixtures/mcp-windows-client.fixture.cjs', import.meta.url));
  const args = ['--', convert('-u', windowsNode), convert('-w', driver), convert('-w', configPath)];
  if (expectedProject !== undefined) args.push(expectedProject);
  if (expectedApiPort !== undefined) args.push(expectedApiPort);
  // A real Windows process is necessary: passing entry.env to a Linux child
  // directly does not model a GUI client's Windows-to-WSL WSLENV propagation.
  return execute('/usr/bin/env', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 1024 * 1024 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(runWindowsMcpSmoke(...process.argv.slice(2)));
}
