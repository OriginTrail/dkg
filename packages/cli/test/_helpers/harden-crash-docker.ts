import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_LOG_MAX_SIZE, BLAZEGRAPH_LOG_MAX_FILE,
  blazegraphMigrationVolumeName, type DockerRunner } from '../../src/daemon/blazegraph-docker.js';
export const CRASH_NAME = 'dkg-crash-owner', CRASH_NAMESPACE = 'owner', CRASH_BYTES = 1024;
export function crashDocker(home: string) {
  const path = join(home, 'docker-state.json');
  const state: { stopped: boolean; renamed: boolean; replacement: boolean; attempt: string | null; mount?: string; sourceId?: string } = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8')) : { stopped: false, renamed: false, replacement: false, attempt: null };
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(state));
  const calls: string[][] = [], volume = blazegraphMigrationVolumeName(CRASH_NAME);
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  const missing = (target: string) => ({ stdout: '', stderr: `Error: No such object: ${target}`, exitCode: 1 });
  const inspect = (hardened: boolean, running: boolean) => ok(JSON.stringify([{
    Id: hardened ? 'replacement-container-id' : state.sourceId ?? 'original-container-id',
    State: { Running: running, StartedAt: '2026-01-01', FinishedAt: '2026-01-02' }, SizeRw: CRASH_BYTES,
    Mounts: hardened ? [{ Destination: BLAZEGRAPH_DATA_DIR, Name: state.mount ?? volume, Type: 'volume' }] : [],
    Config: hardened ? { Env: ['TOMCAT_JAVA_OPTS=-Xmx256m -XX:+ExitOnOutOfMemoryError'], Healthcheck: { Test: ['CMD-SHELL', 'curl ASK%7B%7D'] } } : {},
    HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '9999' }] },
      ...(hardened ? { LogConfig: { Type: 'local', Config: { 'max-size': BLAZEGRAPH_LOG_MAX_SIZE, 'max-file': BLAZEGRAPH_LOG_MAX_FILE } } } : {}) },
  }]));
  const runner: DockerRunner = { async run(args) {
    calls.push([...args]);
    if (args[0] === 'inspect') {
      const name = args.at(-1);
      if (name === CRASH_NAME) return state.replacement ? inspect(true, true)
        : state.renamed ? missing(CRASH_NAME) : inspect(false, !state.stopped);
      return name === `${CRASH_NAME}-backup` && state.renamed ? inspect(false, false) : missing(name!);
    }
    if (args[0] === 'exec') return ok(String(CRASH_BYTES));
    if (args[0] === 'volume' && args[1] === 'inspect') return state.attempt === null
      ? { stdout: '', stderr: `Error response from daemon: get ${volume}: no such volume`, exitCode: 1 }
      : ok(JSON.stringify([{ Name: volume, Labels: { 'org.origintrail.dkg.harden-attempt': state.attempt } }]));
    if (args[0] === 'volume') state.attempt = args[3]!.split('=').slice(1).join('=');
    if (args[0] === 'stop') state.stopped = true;
    if (args[0] === 'cp') writeFileSync(args[2]!, Buffer.alloc(CRASH_BYTES, 7));
    if (args[0] === 'rename') { state.renamed = args[1] === CRASH_NAME; if (!state.renamed) state.replacement = false; }
    if (args[0] === 'run' && args[1] === '-d') state.replacement = true;
    if (args[0] === 'rm') state.replacement = false;
    writeFileSync(path, JSON.stringify(state));
    return ok(args.includes('--rm') ? String(CRASH_BYTES) : '');
  } };
  return { runner, calls };
}
export const crashVerifier: typeof globalThis.fetch = async (_, init) => String(init?.body).includes('SELECT')
  ? new Response(JSON.stringify({ results: { bindings: [{ name: { value: 'owner' } }] } }))
  : new Response('ok');
