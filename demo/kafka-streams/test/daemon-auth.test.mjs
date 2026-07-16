import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDkgConfig } from '../lib/config-file.mjs';
import { resolveDaemonAuth } from '../lib/daemon-auth.mjs';
async function withHome(setup, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'kafka-streams-demo-auth-'));
  try {
    await setup(dir);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('resolveDaemonAuth reads api.port + auth.token from DKG_HOME', async () => {
  await withHome(async (dir) => {
    await writeFile(join(dir, 'api.port'), '9301\n');
    await writeFile(join(dir, 'auth.token'), 'secret-token\n');
  }, async (dir) => {
    const auth = await resolveDaemonAuth(dir, { useEnvPort: false });
    assert.equal(auth.baseUrl, 'http://127.0.0.1:9301');
    assert.equal(auth.token, 'secret-token');
    assert.equal(auth.authEnabled, true);
  });
});
test('resolveDaemonAuth ignores ambient DKG_API_PORT unless explicitly opted in', async () => {
  await withHome(async (dir) => {
    await writeFile(join(dir, 'api.port'), '9301\n');
    await writeFile(join(dir, 'auth.token'), 'secret-token\n');
  }, async (dir) => {
    const oldPort = process.env.DKG_API_PORT;
    process.env.DKG_API_PORT = '9402';
    try {
      const auth = await resolveDaemonAuth(dir);
      assert.equal(auth.baseUrl, 'http://127.0.0.1:9301');
      const envAuth = await resolveDaemonAuth(dir, { useEnvPort: true });
      assert.equal(envAuth.baseUrl, 'http://127.0.0.1:9402');
    } finally {
      if (oldPort === undefined) {
        delete process.env.DKG_API_PORT;
      } else {
        process.env.DKG_API_PORT = oldPort;
      }
    }
  });
});
test('resolveDaemonAuth honours config.json:auth.tokens[] over file', async () => {
  await withHome(async (dir) => {
    await writeFile(join(dir, 'api.port'), '9999');
    await writeFile(join(dir, 'auth.token'), 'file-token');
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ auth: { enabled: true, tokens: ['cfg-token'] } }),
    );
  }, async (dir) => {
    const auth = await resolveDaemonAuth(dir, { useEnvPort: false });
    assert.equal(auth.token, 'cfg-token');
  });
});
test('resolveDaemonAuth supports config.yaml and keeps config.json precedence', async () => {
  await withHome(async (dir) => {
    await writeFile(join(dir, 'api.port'), '9999');
    await writeFile(join(dir, 'config.yaml'), 'auth:\n  enabled: true\n  tokens:\n    - "yaml # token"\n');
  }, async (dir) => {
    const auth = await resolveDaemonAuth(dir, { useEnvPort: false });
    assert.equal(auth.token, 'yaml # token');
    assert.equal(auth.authEnabled, true);
  });
  await withHome(async (dir) => {
    await writeFile(join(dir, 'api.port'), '9999');
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ auth: { enabled: true, tokens: ['json-token'] } }),
    );
    await writeFile(join(dir, 'config.yaml'), 'auth:\n  enabled: true\n  tokens:\n    - yaml-token\n');
  }, async (dir) => {
    const auth = await resolveDaemonAuth(dir, { useEnvPort: false });
    assert.equal(auth.token, 'json-token');
  });
  await withHome(async (dir) => {
    await writeFile(join(dir, 'api.port'), '7000');
    await writeFile(join(dir, 'config.yaml'), 'auth:\n  enabled: false\n');
  }, async (dir) => {
    const auth = await resolveDaemonAuth(dir, { useEnvPort: false });
    assert.equal(auth.token, undefined);
    assert.equal(auth.authEnabled, false);
  });
});
test('readDkgConfig falls back to config.yaml when config.json is malformed and tolerated', async () => {
  await withHome(async (dir) => {
    await writeFile(join(dir, 'config.json'), '{not-json');
    await writeFile(join(dir, 'config.yaml'), 'auth:\n  enabled: true\n  tokens:\n    - yaml-token\n');
  }, async (dir) => {
    const { config } = await readDkgConfig(dir, { tolerateMalformed: true });
    assert.equal(config.auth.tokens[0], 'yaml-token');
  });
});
test('resolveDaemonAuth throws when port file missing', async () => {
  await withHome(async () => {}, async (dir) => {
    await assert.rejects(resolveDaemonAuth(dir, { useEnvPort: false }), /api\.port/);
  });
});
