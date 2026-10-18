// Actual Windows client for the mandatory WSL integration fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(process.platform, 'win32');
const entry = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers.dkg;
const expectedProject = process.argv[3];
assert(expectedProject, 'Expected project marker is required');
assert.equal(entry.env.DKG_PROJECT, expectedProject);
async function main() {
  const started = Date.now();
  const stage = label => process.stderr.write('[native-wsl] ' + label + ' after ' + (Date.now() - started) + 'ms\n');
  stage('Windows client loading SDK');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  stage('launching exact registered WSL command');
  const transport = new StdioClientTransport({command:entry.command,args:entry.args,env:{...process.env,WSLENV:'',...entry.env},stderr:'pipe'});
  let stderr = ''; transport.stderr.on('data', data => { stderr = (stderr + data).slice(-64 * 1024); });
  const client = new Client({name:'native-wsl-regression',version:'1'});
  let timer;
  try {
    await Promise.race([(async () => {
      await client.connect(transport, { timeout: 240000 });
      stage('production MCP initialized');
      assert.equal(client.getServerVersion().name, 'dkg');
      const result = await client.listTools();
      stage('production MCP tools listed');
      assert(result.tools.length > 0, 'MCP must expose its DKG tools');
      assert.match(stderr, /59231/, 'MCP must load the selected DKG_HOME with spaces and quotes');
      assert(stderr.includes('project=' + expectedProject), 'MCP must receive the configured project through WSLENV');
      process.stdout.write('Windows client → pinned WSL → production MCP initialize/tools-list passed\n');
    })(),new Promise((_,reject) => {timer=setTimeout(() => reject(new Error('MCP launch timed out after 240000ms')),240000);})]);
  } catch (error) {
    stage('registered MCP launch failed');
    process.stderr.write('[native-wsl] child stderr tail:\n' + (stderr || '<empty>') + '\n');
    throw error;
  } finally { clearTimeout(timer); await client.close(); await transport.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
