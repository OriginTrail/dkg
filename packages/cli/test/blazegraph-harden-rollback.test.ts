/** Standalone rollback ownership and remaining command instructions. */
import { describe, it, expect } from 'vitest';
import { type DockerRunner } from '../src/daemon/blazegraph-docker.js';
import { rollbackToBackup } from '../src/daemon/harden/rollback.js';
import { NAME, BACKUP, inspectJson, notFound, ok } from './_helpers/blazegraph-harden-fixtures.js';

describe('rollbackToBackup command retirement', () => {
  it.each([0, 1, 2, 3])('reports exactly the rollback suffix beginning at failed command %s', async (failed) => {
    const commands = [
      ['rm', '-f', NAME], ['rename', BACKUP, NAME],
      ['update', '--restart=unless-stopped', NAME], ['start', NAME],
    ];
    const calls: string[][] = [];
    const logs: string[] = [];
    const docker: DockerRunner = { run: async args => {
      calls.push([...args]);
      if (args[0] === 'inspect') return ok(inspectJson({ hardened: true }));
      return args.join(' ') === commands[failed]!.join(' ')
        ? { stdout: '', stderr: 'forced failure', exitCode: 1 } : ok();
    } };
    await expect(rollbackToBackup({ docker, containerName: NAME, backupName: BACKUP, log: m => logs.push(m) }))
      .resolves.toMatchObject({ complete: false });
    expect(calls.slice(1)).toEqual(commands.slice(0, failed + 1));
    expect(logs.join('\n').split('\n').filter(line => line.startsWith('  docker ')))
      .toEqual(commands.slice(failed).map(args => `  docker ${args.join(' ')}`));
  });

  it('reports the failed rollback command and suffix when Docker rejects its invocation', async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const docker: DockerRunner = { run: async args => {
      calls.push([...args]);
      if (args[0] === 'inspect') return notFound;
      if (args[0] === 'update') throw new Error('spawn unavailable');
      return ok();
    } };
    await expect(rollbackToBackup({ docker, containerName: NAME, backupName: BACKUP, log: m => logs.push(m) }))
      .resolves.toMatchObject({ complete: false, failedStep: 'restore-restart-policy' });
    expect(calls.some(args => args[0] === 'start')).toBe(false);
    expect(logs.join('\n').split('\n').filter(line => line.startsWith('  docker '))).toEqual([
      `  docker update --restart=unless-stopped ${NAME}`, `  docker start ${NAME}`,
    ]);
  });

});
