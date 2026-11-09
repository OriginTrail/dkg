import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the companion regressions in the existing test:scripts CI lane. The DKG
// profile fixture needs its own process, as in a real companion startup.
test('Studio MCP native transport, durability, authority and read-profile regressions', () => {
  const env = { ...process.env };
  for (const key of ['NOS_STUDIO_SESSION_FILE', 'NOS_DKG_PROFILE_MODULE', 'NOS_STUDIO_MCP', 'NOS_STUDIO_MCP_AGENT_PREVIEW', 'NODE_TEST_CONTEXT']) delete env[key];
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'examples/n8n-capability/studio-mcp.test.mjs', 'examples/n8n-capability/studio-mcp-dkg.test.mjs'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env, timeout: 30_000, stdio: 'pipe', encoding: 'utf8',
  });
  assert.match(output, /# tests \d+\b/);
  assert.match(output, /# fail 0\b/);
});
