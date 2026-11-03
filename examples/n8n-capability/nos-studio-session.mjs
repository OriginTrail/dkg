import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

export function loadNosStudioSession(file = process.env.NOS_STUDIO_SESSION_FILE) {
  if (!file) return null;
  if (!isAbsolute(file)) throw new Error('Absolute operator Studio configuration required.');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const url = new URL(config.controlPlaneUrl);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.accountId ?? '') ||
      url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.href !== url.origin + '/' || !isAbsolute(config.secretFile ?? ''))
    throw new Error('A single account and loopback nOS control plane are required.');
  const secret = () => {
    const value = readFileSync(config.secretFile, 'utf8').trim();
    if (!/^[!-~]{32,512}$/.test(value)) throw new Error('Studio service credential unavailable.');
    return value;
  };
  secret();
  return { accountId: config.accountId, controlPlaneUrl: url.origin, secret,
    bindState(state) {
      const file = join(state, 'nos-account.json');
      if (!existsSync(file)) {
        if (!config.adoptExistingState && existsSync(join(state, 'studio.sqlite')))
          throw new Error('Existing Studio state requires explicit operator adoption.');
        writeFileSync(file, JSON.stringify({ accountId: config.accountId }), { flag: 'wx', mode: 0o600 });
      }
      if (JSON.parse(readFileSync(file, 'utf8')).accountId !== config.accountId)
        throw new Error('This companion state belongs to a different account.');
    },
    actor(headers) {
      const digest = value => createHash('sha256').update(String(value ?? '')).digest();
      if (headers.authorization || !timingSafeEqual(digest(headers['x-nos-workflows-secret']), digest(secret())) ||
          headers['x-nos-workflows-account'] !== config.accountId ||
          !['owner', 'operator', 'viewer'].includes(headers['x-nos-workflows-role']) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(headers['x-nos-workflows-principal'] ?? ''))
        throw Object.assign(new Error('Authenticated nOS account context required.'), { status: 403 });
      return { id: headers['x-nos-workflows-principal'], accountId: config.accountId, role: headers['x-nos-workflows-role'] };
    },
  };
}
export const nosStudioSession = loadNosStudioSession();
