import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readDkgConfig } from './config-file.mjs';

export async function resolveDaemonAuth(dkgHome, { useEnvPort = false } = {}) {
  const portPath = join(dkgHome, 'api.port');
  let portSource = useEnvPort ? process.env.DKG_API_PORT : undefined;
  if (portSource === undefined) {
    try {
      portSource = await readFile(portPath, 'utf-8');
    } catch (err) {
      throw new Error(`Cannot read api.port from ${dkgHome}: ${err?.message ?? err}`);
    }
  }
  const port = Number.parseInt(portSource.trim(), 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Malformed api.port in ${dkgHome}`);
  }

  let authEnabled = true;
  let token;
  const { config: cfg } = await readDkgConfig(dkgHome, { tolerateMalformed: true });
  if (cfg && typeof cfg === 'object') {
    if (cfg?.auth?.enabled === false) authEnabled = false;
    const cfgTokens = cfg?.auth?.tokens;
    if (Array.isArray(cfgTokens)) {
      const t = cfgTokens.find((s) => typeof s === 'string' && s.length > 0);
      if (t) token = t;
    }
  }
  if (!token) {
    try {
      token = (await readFile(join(dkgHome, 'auth.token'), 'utf-8'))
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
    } catch {
      // No file token either.
    }
  }
  if (authEnabled && !token) {
    throw new Error(
      `Daemon at ${dkgHome} has auth.enabled=true but no token ` +
        `(checked config.json, config.yaml + auth.token).`,
    );
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token, authEnabled };
}
