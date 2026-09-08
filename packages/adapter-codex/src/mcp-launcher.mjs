import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Credentials are read only in the MCP process, never put in the app-server
// config overrides, saved conversation, process arguments, or browser.
const [cli, dkgHome, dkgPort] = process.argv.slice(2);
if (!cli || !dkgHome || !/^\d+$/.test(dkgPort || '')) throw new Error('Expected DKG CLI, home, and port.');
const token = readFileSync(join(dkgHome, 'auth.token'), 'utf8').split(/\r?\n/)
  .map((s) => s.trim()).find((s) => s && !s.startsWith('#')) || '';
const env = { ...process.env, DKG_HOME: dkgHome, DKG_API: `http://127.0.0.1:${dkgPort}`, DKG_TOKEN: token };
delete env.DKG_PROJECT; delete env.DEVNET_API; delete env.DEVNET_TOKEN;
const child = spawn(process.execPath, [cli, 'mcp', 'serve'], { stdio: 'inherit', env });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
