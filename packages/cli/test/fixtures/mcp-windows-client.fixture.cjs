// SPDX-License-Identifier: Apache-2.0
// Shared actual Windows client for the native fixture and contributor WSL smoke.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parse, printParseErrorCode } = require('jsonc-parser');

function readRegistration(configPath) {
  const errors = [];
  const config = parse(fs.readFileSync(configPath, 'utf8'), errors, { allowTrailingComma: true });
  assert.equal(errors.length, 0, `Invalid client JSON: ${errors.map(error => printParseErrorCode(error.error)).join(', ')}`);
  const entry = config?.mcpServers?.dkg ?? config?.servers?.dkg;
  assert(entry && typeof entry.command === 'string' && /\\System32\\wsl\.exe$/i.test(entry.command)
    && Array.isArray(entry.args) && entry.args.every(value => typeof value === 'string'),
  'The config must contain a Windows wsl.exe DKG registration');
  assert(entry.env && Object.values(entry.env).every(value => typeof value === 'string'), 'Registration env must contain string values');
  assert(typeof entry.env.DKG_PROJECT === 'string' && entry.env.DKG_PROJECT.length > 0,
    'Configure DKG_PROJECT in the Windows client entry to verify environment forwarding');
  return entry;
}

async function runWindowsClient(entry, expectedProject = entry.env.DKG_PROJECT, expectedApiPort, runtime = {}) {
  const { platform = process.platform, env = process.env,
    Client = require('@modelcontextprotocol/sdk/client/index.js').Client,
    StdioClientTransport = require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport,
    output = process.stdout, diagnostic = process.stderr } = runtime;
  assert.equal(platform, 'win32', 'The MCP client must run in Windows Node');
  assert.equal(entry.env.DKG_PROJECT, expectedProject, 'Configured project differs from expected project');
  const started = Date.now();
  const stage = label => diagnostic.write('[native-wsl] ' + label + ' after ' + (Date.now() - started) + 'ms\n');
  stage('launching exact registered WSL command');
  // Clear inherited WSLENV so this proof depends on the persisted registration.
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args,
    env: { ...env, WSLENV: '', ...entry.env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr = (stderr + data).slice(-64 * 1024); });
  const client = new Client({ name: 'native-wsl-regression', version: '1' });
  let timer;
  try {
    await Promise.race([(async () => {
      await client.connect(transport, { timeout: 240000 });
      stage('production MCP initialized');
      assert.equal(client.getServerVersion().name, 'dkg');
      const result = await client.listTools();
      stage('production MCP tools listed');
      assert(result.tools.length > 0, 'MCP must expose its DKG tools');
      if (expectedApiPort !== undefined) {
        assert(stderr.includes(':' + expectedApiPort), 'MCP must load the selected DKG_HOME API port');
      }
      assert(stderr.includes('project=' + expectedProject + ' · agent='), 'MCP must receive the configured project through WSLENV');
      output.write('Windows client → pinned WSL → production MCP initialize/tools-list passed\n');
    })(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('MCP launch timed out after 240000ms')), 240000);
    })]);
  } catch (error) {
    stage('registered MCP launch failed');
    diagnostic.write('[native-wsl] child stderr tail:\n' + (stderr || '<empty>') + '\n');
    throw error;
  } finally { clearTimeout(timer); await client.close(); await transport.close(); }
}

module.exports = { readRegistration, runWindowsClient };
if (require.main === module) {
  Promise.resolve().then(() => runWindowsClient(readRegistration(process.argv[2]), process.argv[3], process.argv[4]))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
