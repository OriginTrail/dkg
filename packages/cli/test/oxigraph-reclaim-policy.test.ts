/**
 * Orphaned managed Oxigraph — the reclaim's pure policy
 * (`oxigraph-reclaim-policy.ts`): who owns the store, which lock holders may
 * be stopped, and how a holder's command line is matched to this node's
 * Oxigraph for this store. Decisions from explicit observations; no
 * processes, files or timers. `oxigraph-orphan-policy.test.ts` covers the
 * reaper that gathers those observations and signals.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { createOxigraphLaunchStrategy } from '../src/daemon/oxigraph-launch-strategy.js';
import { oxigraphStoreArgs } from '../src/daemon/oxigraph-store-launch.js';
import {
  OXIGRAPH_OWNER_RECORD_SCHEMA,
  type OxigraphOwnerRecordV1,
} from '../src/daemon/oxigraph-owner-record.js';
import {
  classifyHolder,
  deriveOwnership,
  describeStoreHold,
  isCatalogedOxigraph,
  leaveBlock,
  matchManagedOxigraphStore,
  oxigraphBinaryCatalog,
  withOxigraphBinary,
} from '../src/daemon/oxigraph-reclaim-policy.js';

describe('the orphan reclaim policy', () => {
  const binaryPath = '/home/dkg/.dkg/oxigraph/oxigraph-v0.5.8';
  const serve = (store: string, binary = binaryPath) =>
    [binary, ...oxigraphStoreArgs(store), '--bind', '127.0.0.1:7901'];
  const identity = (pid: number) => ({ pid, start: `t${pid}` });

  describe('pure decisions from explicit observations', () => {
    const instance = (pid: number, ppid: number, argv: string[], start = `t${pid}`) =>
      ({ pid, start, ppid, argv, command: argv.join(' ') });
    const binaries = { exact: [binaryPath], cacheDir: null };
    const record: OxigraphOwnerRecordV1 = {
      schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
      boot: 'boot-1',
      daemon: identity(4000),
      launcher: identity(4099),
      binaryPath,
    };

    const running = { state: 'running' } as const;
    const gone = { state: 'gone' } as const;
    const unknown = { state: 'unknown', reason: 'ps timed out' } as const;
    const complete = { state: 'complete' } as const;

    it('derives ownership from the record and the states of the recorded processes', () => {
      expect(deriveOwnership({ kind: 'absent' }, null, 'boot-1')).toEqual({ kind: 'unrecorded' });
      expect(deriveOwnership({ kind: 'invalid' }, null, 'boot-1')).toEqual({ kind: 'unrecorded' });
      expect(deriveOwnership({ kind: 'unreadable', reason: 'EACCES' }, null, 'boot-1'))
        .toEqual({ kind: 'unknown', reason: 'the owner record could not be read: EACCES' });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: running, launcher: running }, 'boot-1'))
        .toEqual({ kind: 'owners-live', record });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: gone, launcher: running }, 'boot-1'))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'daemon', pid: 4000 } });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: running, launcher: gone }, 'boot-1'))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'launcher', pid: 4099 } });
      // One confirmed exit is enough; otherwise an unreadable owner is unknown.
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: unknown, launcher: gone }, 'boot-1'))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'launcher', pid: 4099 } });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: running, launcher: unknown }, 'boot-1')).toEqual({
        kind: 'unknown',
        reason: 'could not tell whether the recorded launcher pid 4099 is still running: ps timed out',
      });
      expect(deriveOwnership({ kind: 'v1', record }, null, 'boot-1'))
        .toEqual({ kind: 'unknown', reason: 'the recorded owners were not checked' });
      // A record from an earlier boot names nothing now; one that cannot be
      // matched to this boot proves nothing.
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: running, launcher: running }, 'boot-2'))
        .toEqual({ kind: 'unrecorded' });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: gone, launcher: gone }, null))
        .toMatchObject({ kind: 'unknown' });
    });

    it('leaves every holder while ownership is unknown, even one adopted by PID 1', () => {
      const ownership = deriveOwnership({ kind: 'unreadable', reason: 'EIO' }, null, 'boot-1');
      expect(classifyHolder(
        { holder: instance(4100, 1, serve('/data/ox')), ancestors: [], ancestryEnd: complete },
        { location: '/data/ox', ownership, binaries },
      )).toEqual({
        action: 'leave',
        reason: { kind: 'ownership-unknown', reason: 'the owner record could not be read: EIO' },
      });
    });

    it('stops a descendant of the recorded launcher, and leaves one whose launcher start time differs', () => {
      const ownership = deriveOwnership({ kind: 'v1', record }, { daemon: gone, launcher: running }, 'boot-1');
      const holder = instance(4101, 4100, serve('/data/ox'));
      const watchdog = instance(4100, 4099, ['node', 'oxigraph-parent-watchdog.js', '4000']);
      const scope = instance(4099, 1, ['systemd-run', '--scope']);
      expect(classifyHolder(
        { holder, ancestors: [watchdog, scope], ancestryEnd: complete },
        { location: '/data/ox', ownership, binaries },
      )).toEqual({ action: 'stop', reason: { kind: 'owner-gone', role: 'daemon', pid: 4000 } });
      const impostor = instance(4099, 1, ['/bin/bash'], 'later');
      expect(classifyHolder(
        { holder, ancestors: [watchdog, impostor], ancestryEnd: complete },
        { location: '/data/ox', ownership, binaries },
      )).toMatchObject({ action: 'leave', reason: { kind: 'parent-alive', ppid: 4100, recorded: true } });
    });

    it('stops a holder only when its parent has confirmedly exited, without a record', () => {
      const ownership = deriveOwnership({ kind: 'absent' }, null, 'boot-1');
      const holder = instance(4100, 4099, serve('/data/ox'));
      const ctx = { location: '/data/ox', ownership, binaries };
      expect(classifyHolder({ holder, ancestors: [], ancestryEnd: gone }, ctx))
        .toEqual({ action: 'stop', reason: { kind: 'parent-exited', ppid: 4099 } });
      expect(classifyHolder({ holder, ancestors: [], ancestryEnd: unknown }, ctx))
        .toEqual({ action: 'leave', reason: { kind: 'parent-unknown', ppid: 4099, reason: 'ps timed out' } });
      expect(classifyHolder({ holder, ancestors: [instance(4099, 1, ['/bin/bash'])], ancestryEnd: complete }, ctx))
        .toEqual({
          action: 'leave',
          reason: { kind: 'parent-alive', ppid: 4099, parentCommand: '/bin/bash', recorded: false },
        });
    });
  });

  it('describes why a store may still be held, at the logging boundary', () => {
    expect(describeStoreHold({ kind: 'holders-unlisted' })).toBe('its lock holders could not be listed');
    expect(describeStoreHold({ kind: 'not-confirmed-gone', pids: [4100, 4200] }))
      .toBe('orphaned Oxigraph pid 4100, 4200 was not confirmed gone');
    expect(describeStoreHold({
      kind: 'holders-left',
      holders: [
        { pid: 4100, block: { kind: 'left', reason: { kind: 'owners-live', daemonPid: 4000, launcherPid: 4099 } } },
        { pid: 4200, block: { kind: 'signal-refused' } },
        { pid: 4300, block: { kind: 'unconfirmed', reason: 'ps timed out' } },
        { pid: 4400, block: { kind: 'uninspectable', reason: 'EIO' } },
      ],
    })).toBe(
      'pid 4100: this store\'s recorded daemon pid 4000 and launcher pid 4099 are still running; ' +
        'pid 4200: its signal was refused; ' +
        'pid 4300: it could not be re-checked before its signal (ps timed out); ' +
        'pid 4400: it could not be inspected (EIO)',
    );
    // Only a holder that is not this node's Oxigraph for this store leaves it free.
    expect(leaveBlock({ kind: 'not-this-store' })).toBeNull();
    expect(leaveBlock({ kind: 'argv-ambiguous' })).toEqual({ kind: 'left', reason: { kind: 'argv-ambiguous' } });
  });

  it('recognises the exact Oxigraph argv that the direct and scoped launches build', () => {
    const serveArgs = [...oxigraphStoreArgs('/data/ox'), '--bind', '127.0.0.1:7878'];
    for (const memoryLimits of [undefined, { maxMiB: 3072 }]) {
      let launched: readonly string[] = [];
      createOxigraphLaunchStrategy({
        memoryLimits,
        platform: 'linux',
        parentPid: 42,
        uid: 1000,
        nodeExecutable: '/opt/node',
        watchdogPath: '/opt/oxigraph-watchdog.js',
      }).launch(((_command: string, args: readonly string[]) => {
        launched = args;
        return Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null }) as unknown as ChildProcess;
      }) as unknown as typeof spawn, binaryPath, serveArgs, 'ignore');
      // The argv the watchdog execs for Oxigraph: the binary and its arguments.
      const argv = launched.slice(launched.indexOf(binaryPath));
      expect(matchManagedOxigraphStore(
        { argv, command: argv.join(' ') }, '/data/ox', { exact: [binaryPath], cacheDir: null },
      )).toBe('match');
    }
  });

  it('recognises an exact binary, or a pinned release in the managed cache, and nothing beside them', () => {
    const catalog = withOxigraphBinary(
      { exact: ['/opt/dkg/oxigraph/oxigraph-v0.5.8'], cacheDir: '/opt/dkg/oxigraph' },
      '/usr/local/bin/oxigraph',
    );
    expect(catalog).toEqual({
      exact: ['/opt/dkg/oxigraph/oxigraph-v0.5.8', '/usr/local/bin/oxigraph'],
      cacheDir: '/opt/dkg/oxigraph',
    });
    expect(isCatalogedOxigraph(catalog, '/usr/local/bin/oxigraph')).toBe(true);
    expect(isCatalogedOxigraph(catalog, '/opt/dkg/oxigraph/oxigraph-v0.5.7')).toBe(true);
    expect(isCatalogedOxigraph(catalog, '/opt/dkg/oxigraph/../oxigraph/oxigraph-v0.5.6')).toBe(true);
    // Other oxigraph* tools beside an exact binary or in the cache, another
    // program in the cache, a pinned name outside it, an oxigraph elsewhere.
    expect(isCatalogedOxigraph(catalog, '/usr/local/bin/oxigraph-server')).toBe(false);
    expect(isCatalogedOxigraph(catalog, '/usr/local/bin/oxigraph-backup')).toBe(false);
    expect(isCatalogedOxigraph(catalog, '/usr/local/bin/oxigraph-v0.5.7')).toBe(false);
    expect(isCatalogedOxigraph(catalog, '/opt/dkg/oxigraph/oxigraph-server')).toBe(false);
    expect(isCatalogedOxigraph(catalog, '/opt/dkg/oxigraph/rocksdb-tool')).toBe(false);
    expect(isCatalogedOxigraph(catalog, '/tmp/oxigraph')).toBe(false);
    // Without resolved locations, the one binary alone.
    const single = oxigraphBinaryCatalog('/opt/dkg/oxigraph/oxigraph-v0.5.8');
    expect(single).toEqual({ exact: ['/opt/dkg/oxigraph/oxigraph-v0.5.8'], cacheDir: null });
    expect(isCatalogedOxigraph(single, '/opt/dkg/oxigraph/oxigraph-v0.5.7')).toBe(false);
  });

  it('compares exact argv token by token, including paths with spaces', () => {
    const binaries = { exact: ['/opt/oxigraph'], cacheDir: '/opt' };
    const exact = (argv: string[]) => ({ argv, command: argv.join(' ') });
    expect(matchManagedOxigraphStore(exact(['/opt/oxigraph', 'serve', '--location', '/data/store name']), '/data/store name', binaries)).toBe('match');
    // Flattened, these two are the same text; as argv they differ.
    expect(matchManagedOxigraphStore(exact(['/opt/oxigraph', 'serve', '--location', '/data/store', 'name']), '/data/store name', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['node', '/opt/oxigraph-v0.5.7', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('match');
    // A catalogued path among another program's arguments is not its executable.
    const foreign = ['node', 'backup.js', '/opt/oxigraph-v0.5.8', 'serve', '--location', '/data/ox'];
    expect(matchManagedOxigraphStore(exact(foreign), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore({ argv: null, command: foreign.join(' ') }, '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/usr/bin/rsync', '/opt/oxigraph', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/opt/oxigraph', 'serve', '--location', '/data/ox2']), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/opt/other/oxigraph', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/opt/python3', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('no-match');
  });

  it('matches display-only text only when neither the store nor a binary path has whitespace', () => {
    const display = (command: string) => ({ argv: null, command });
    const binaries = { exact: ['/opt/oxigraph'], cacheDir: '/opt' };
    expect(matchManagedOxigraphStore(display('/opt/oxigraph serve --location /data/ox --bind 127.0.0.1:7878'), '/data/ox', binaries)).toBe('match');
    expect(matchManagedOxigraphStore(display('/opt/oxigraph serve --location /data/ox2'), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(display('/opt/oxigraph serve --location /data/store name'), '/data/store name', binaries)).toBe('ambiguous');
    expect(matchManagedOxigraphStore(display('/my apps/oxigraph serve --location /data/ox'), '/data/ox', { exact: ['/my apps/oxigraph'], cacheDir: null })).toBe('ambiguous');
    expect(matchManagedOxigraphStore(display('/opt/oxigraph serve --location /data/ox'), '/data/ox', { exact: ['/opt/oxigraph'], cacheDir: '/my cache' })).toBe('ambiguous');
  });
});
