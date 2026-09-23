import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Read the owner credential locally; never print it or put it in a saved link.
try {
  const configPath = process.argv[2] || process.env.DKG_CODEX_CONFIG;
  const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const port = config.port ?? 9210;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge port.');
  const stateDir = config.stateDir || join(config.dkgHome || join(homedir(), '.dkg'), 'codex');
  let token;
  try { token = readFileSync(join(stateDir, 'ui-bootstrap.token'), 'utf8').trim(); }
  catch { throw new Error('Start the DKG Codex service before opening its UI.'); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('The UI owner credential is invalid.');
  const opener = { darwin: 'open', linux: 'xdg-open', win32: 'explorer.exe' }[process.platform];
  if (!opener) throw new Error('No browser launcher is configured for this platform.');
  await new Promise((resolve, reject) => {
    const child = spawn(opener, [`http://127.0.0.1:${port}/ui/codex#${token}`], { stdio: 'ignore' });
    child.once('error', () => reject(new Error('Could not start the browser.')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('The browser launcher failed.')));
  });
  console.log(`Opened DKG Codex at http://127.0.0.1:${port}/ui/codex`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
