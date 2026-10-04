// Shared scripted Docker, fetch and journal fixtures for hardening suites.
import { expect } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HARDEN_BACKUP_SUFFIX, HARDEN_EXPORT_FILENAME } from '../../src/daemon/blazegraph-harden.js';
import { BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_LOG_MAX_SIZE, BLAZEGRAPH_LOG_MAX_FILE, blazegraphMigrationVolumeName as blazegraphVolumeName, type DockerRunner, type DockerCommandResult } from '../../src/daemon/blazegraph-docker.js';

export const NAME = 'dkg-blazegraph-dkg';
export const BACKUP = `${NAME}${HARDEN_BACKUP_SUFFIX}`;
export const VOLUME = blazegraphVolumeName(NAME);
export const NAMESPACE = 'dkg';
export const JOURNAL_BYTES = 1000;
export const STARTED_AT = '2026-07-18T00:00:00.000000000Z';
export const FINISHED_AT = '2026-07-18T00:10:00.000000000Z';

export function inspectJson(shape: {
  running?: boolean;
  hardened?: boolean;
  hostPort?: string;
  startedAt?: string;
  finishedAt?: string;
  sizeRw?: number;
  /** Stopped-container realism: NetworkSettings.Ports is EMPTY once stopped. */
  networkPortsEmpty?: boolean;
  /** No port configuration anywhere (neither durable nor runtime). */
  noPorts?: boolean;
}): string {
  const bindings = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: shape.hostPort ?? '9999' }] };
  return JSON.stringify([{
    State: {
      Running: shape.running ?? true,
      StartedAt: shape.startedAt ?? STARTED_AT,
      FinishedAt: shape.finishedAt ?? FINISHED_AT,
    },
    // Fleet-verified legacy shape: Mounts [] (journal in the writable layer).
    Mounts: shape.hardened
      ? [{ Destination: BLAZEGRAPH_DATA_DIR, Name: VOLUME }]
      : [],
    Config: shape.hardened ? { Env: ['TOMCAT_JAVA_OPTS=-Xmx2048m -XX:+ExitOnOutOfMemoryError'], Healthcheck: { Test: ['CMD-SHELL', 'curl ASK%7B%7D'] } } : {},
    HostConfig: { PortBindings: shape.noPorts ? {} : bindings,
      ...(shape.hardened ? { LogConfig: { Type: 'local', Config: { 'max-size': BLAZEGRAPH_LOG_MAX_SIZE, 'max-file': BLAZEGRAPH_LOG_MAX_FILE } } } : {}) },
    NetworkSettings: {
      Ports: shape.noPorts || shape.networkPortsEmpty ? {} : bindings,
    },
    ...(shape.sizeRw !== undefined ? { SizeRw: shape.sizeRw } : {}),
  }]);
}

export const notFound: DockerCommandResult = {
  stdout: '', stderr: `Error: No such object: ${NAME}`, exitCode: 1,
};
export const ok = (stdout = ''): DockerCommandResult => ({ stdout, stderr: '', exitCode: 0 });

/**
 * Stateful scripted docker: models the world across the migration
 * (stop flips Running, rename flips inspect results, `run -d` creates
 * the hardened container) so the executor's re-derivation of state
 * stays honest. `docker inspect --size` additionally reports SizeRw
 * (writable-layer bytes), mirroring the real CLI.
 */
export function scriptedDocker(opts: {
  initial: 'legacy' | 'legacy-stopped' | 'backup-only' | 'hardened' | 'absent';
  migrationDir: string;
  /** Bytes `docker cp` writes to the export file. Default JOURNAL_BYTES. */
  cpBytes?: number;
  cpFill?: number;
  /** Seed helper stdout. Default String(JOURNAL_BYTES). */
  seedStdout?: string;
  /** In-container journal size reported by `docker exec stat`. */
  statStdout?: string;
  /**
   * Injected step failure/observer: called with every docker argv before
   * the scripted behaviour; return a result to force it, null to pass
   * through. Lets tests fail exactly one rollback step or observe
   * on-disk state mid-migration.
   */
  failOn?: (args: string[]) => DockerCommandResult | null;
  /**
   * Simulate BLOCKER-1 interference: after `docker cp` the container
   * inspect reports a changed StartedAt ('restart' = ran and re-stopped,
   * 'running' = still running).
   */
  interfereAfterCp?: 'restart' | 'running';
  /** Writable-layer byte delta reported after the cp (BLOCKER-1c). */
  sizeRwDelta?: number;
}) {
  const calls: string[][] = [];
  let renamed = opts.initial === 'backup-only';
  let hardenedCreated = opts.initial === 'hardened';
  let stopped = opts.initial === 'legacy-stopped';
  let cpDone = false;
  const runner: DockerRunner = {
    async run(args) {
      calls.push([...args]);
      const forced = opts.failOn?.([...args]);
      if (forced) return forced;
      const [cmd] = args;
      if (cmd === 'inspect') {
        const withSize = args[1] === '--size';
        const target = withSize ? args[2] : args[1];
        if (target === NAME) {
          if (hardenedCreated) return ok(inspectJson({ hardened: true }));
          if (opts.initial === 'absent' || renamed) return { ...notFound, stderr: `Error: No such object: ${target}` };
          const interfered = cpDone && opts.interfereAfterCp !== undefined;
          return ok(inspectJson({
            running: interfered
              ? opts.interfereAfterCp === 'running'
              : opts.initial === 'legacy' && !stopped,
            startedAt: interfered ? '2026-07-18T13:37:00.000000000Z' : STARTED_AT,
            finishedAt: interfered ? '2026-07-18T13:38:00.000000000Z' : FINISHED_AT,
            // Stopped containers have empty runtime Ports — the durable
            // HostConfig.PortBindings is what must carry the port.
            networkPortsEmpty: stopped,
            ...(withSize
              ? { sizeRw: JOURNAL_BYTES + (cpDone ? opts.sizeRwDelta ?? 0 : 0) }
              : {}),
          }));
        }
        if (target === BACKUP) {
          // The backup is always stopped: runtime Ports empty (realistic).
          return renamed
            ? ok(inspectJson({ running: false, networkPortsEmpty: true }))
            : { ...notFound, stderr: `Error: No such object: ${target}` };
        }
        return { ...notFound, stderr: `Error: No such object: ${target}` };
      }
      if (cmd === 'exec') return ok(`${opts.statStdout ?? String(JOURNAL_BYTES)}\n`);
      if (cmd === 'stop') { stopped = true; return ok(); }
      if (cmd === 'cp') {
        writeFileSync(
          join(opts.migrationDir, HARDEN_EXPORT_FILENAME),
          Buffer.alloc(opts.cpBytes ?? JOURNAL_BYTES, opts.cpFill ?? 1),
        );
        cpDone = true;
        return ok();
      }
      if (cmd === 'volume') return ok(VOLUME);
      if (cmd === 'run' && args[1] === '--rm') return ok(`${opts.seedStdout ?? String(JOURNAL_BYTES)}\n`);
      if (cmd === 'run' && args[1] === '-d') {
        hardenedCreated = true;
        return ok('container-id');
      }
      if (cmd === 'rename') {
        if (args[1] === NAME) renamed = true;
        if (args[1] === BACKUP) { renamed = false; hardenedCreated = false; }
        return ok();
      }
      if (cmd === 'rm') {
        hardenedCreated = false;
        return ok();
      }
      return ok();
    },
  };
  return { runner, calls };
}

export function verifierFetch(opts: {
  statusOk?: boolean;
  askOk?: boolean;
  identityPresent?: boolean;
} = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  const fn: typeof globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    calls.push({ url, body });
    if (url.endsWith('/bigdata/status')) {
      return new Response('ok', { status: (opts.statusOk ?? true) ? 200 : 500 });
    }
    if (body.includes(encodeURIComponent('ASK {}'))) {
      return (opts.askOk ?? true)
        ? new Response(JSON.stringify({ boolean: true }), { status: 200 })
        : new Response('dead', { status: 500 });
    }
    if (body.includes('SELECT')) {
      const bindings = (opts.identityPresent ?? true)
        ? [{ name: { type: 'literal', value: 'saturn_station' } }]
        : [];
      return new Response(
        JSON.stringify({ head: { vars: ['name'] }, results: { bindings } }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

/** Invariants that must hold after EVERY executor run, pass or fail. */
export function assertSafetyInvariants(calls: string[][], migrationDir: string, exportExpected: boolean) {
  // The backup container is never removed by any code path.
  expect(calls.some((c) => c[0] === 'rm' && c.includes(BACKUP))).toBe(false);
  // The exported journal is never unlinked.
  if (exportExpected) {
    expect(existsSync(join(migrationDir, HARDEN_EXPORT_FILENAME))).toBe(true);
  }
}
