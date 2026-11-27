import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DkgHomeFiles } from '../src/config.js';

const homes: string[] = [];
async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'dkg-hermes-deadline-'));
  homes.push(home);
  return new DkgHomeFiles(home);
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe.each(['json', 'yaml'] as const)('persisted Hermes deadline in config.%s', format => {
  it.each([0, -1, 1.5, '1000', 86_400_001, null])('rejects invalid value %j during configuration load', async value => {
    const files = await temporaryHome();
    const content = format === 'json'
      ? JSON.stringify({ localAgentIntegrations: { hermes: { responseTimeoutMs: value } } })
      : `localAgentIntegrations:\n  hermes:\n    responseTimeoutMs: ${JSON.stringify(value)}\n`;
    await writeFile(join(files.home, `config.${format}`), content);
    await expect(files.loadConfig()).rejects.toThrow('localAgentIntegrations.hermes.responseTimeoutMs');
  });

  it('loads an omitted deadline without inserting an operator override', async () => {
    const files = await temporaryHome();
    await writeFile(join(files.home, `config.${format}`), format === 'json'
      ? '{"localAgentIntegrations":{"hermes":{"enabled":true}}}'
      : 'localAgentIntegrations:\n  hermes:\n    enabled: true\n');
    expect((await files.loadConfig()).localAgentIntegrations?.hermes).toEqual({ enabled: true });
  });
});

it.each([1, 1_800_000, 86_400_000])('retains a valid %i ms deadline across save and reload', async responseTimeoutMs => {
  const files = await temporaryHome();
  await files.saveConfig({
    ...await files.loadConfig(),
    localAgentIntegrations: { hermes: { enabled: true, responseTimeoutMs } },
  });
  const restarted = new DkgHomeFiles(files.home);
  expect((await restarted.loadConfig()).localAgentIntegrations?.hermes).toEqual({ enabled: true, responseTimeoutMs });
});
