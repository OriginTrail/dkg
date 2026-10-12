import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedOxigraphSparqlStoreV1 } from '@origintrail-official/dkg-storage';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { measureRetainedWalBytes } from '../src/daemon/oxigraph-wal.js';
import { OXIGRAPH_VERSION, resolveOxigraphBinary } from '../src/daemon/oxigraph-binary.js';
import { freePort, sleep } from './fixtures/oxigraph-server-real-fixture.js';

async function executableVersion(binaryPath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Oxigraph --version exited ${code}: ${stderr.trim()}`));
    });
  });
}

let nativeOxigraphTestBinary = process.env.DKG_OXIGRAPH_TEST_BINARY;

describe(
  'managed response completeness (pinned real Oxigraph executable)',
  () => {
    beforeAll(async () => {
      if (nativeOxigraphTestBinary) return;
      const resolved = await resolveOxigraphBinary({
        cacheDir: join(tmpdir(), 'dkg-required-oxigraph-test-binary'),
        log: () => {},
      });
      nativeOxigraphTestBinary = resolved.path;
    }, 120_000);

    it('rejects native-deadline SELECT and CONSTRUCT streams instead of returning partial data', async () => {
      const binaryPath = nativeOxigraphTestBinary!;
      expect(await executableVersion(binaryPath)).toBe(`oxigraph ${OXIGRAPH_VERSION}`);

      const location = await mkdtemp(join(tmpdir(), 'oxi-native-timeout-'));
      const port = await freePort();
      const handle = await startOxigraphServer({
        binaryPath,
        location,
        port,
        queryTimeoutS: 1,
        readyTimeoutMs: 10_000,
        readyIntervalMs: 50,
        stopGraceMs: 2_000,
        restartBackoffBaseMs: 100,
        restartBackoffMaxMs: 200,
        log: () => {},
      });
      const endpoint = `http://127.0.0.1:${port}`;
      const store = createManagedOxigraphSparqlStoreV1({
        queryEndpoint: `${endpoint}/query`,
        updateEndpoint: `${endpoint}/update`,
        timeout: 10_000,
      });

      try {
        await store.insert(Array.from({ length: 100 }, (_, index) => ({
          subject: `urn:s${index}`,
          predicate: 'urn:p',
          object: `"${index}"`,
          graph: '',
        })));
        const expensivePattern = `
          ?a <urn:p> ?x .
          ?b <urn:p> ?y .
          ?c <urn:p> ?z .
          ?d <urn:p> ?w .
          FILTER(SHA512(CONCAT(STR(?a), STR(?b), STR(?c), STR(?d))) != "")
        `;

        await expect(store.query(
          `SELECT (COUNT(*) AS ?count) WHERE { ${expensivePattern} }`,
        )).rejects.toMatchObject({
          code: 'STORE_OPERATION_TIMEOUT',
          backend: 'oxigraph-server',
          operation: 'query',
          outcome: 'indeterminate',
        });
        await expect(store.query(
          `CONSTRUCT { ?a <urn:joined> ?b } WHERE { ${expensivePattern} }`,
        )).rejects.toMatchObject({
          code: 'STORE_OPERATION_TIMEOUT',
          backend: 'oxigraph-server',
          operation: 'construct',
          outcome: 'indeterminate',
        });
      } finally {
        await store.close();
        await handle.stop();
        await rm(location, { recursive: true, force: true });
      }
    }, 30_000);

    it('reopens real retained WAL and preserves written data', async () => {
      const binaryPath = nativeOxigraphTestBinary!;
      expect(await executableVersion(binaryPath)).toBe(`oxigraph ${OXIGRAPH_VERSION}`);

      const location = await mkdtemp(join(tmpdir(), 'oxi-native-wal-maintenance-'));
      const port = await freePort();
      const handle = await startOxigraphServer({
        binaryPath,
        location,
        port,
        readyTimeoutMs: 10_000,
        readyIntervalMs: 50,
        stopGraceMs: 2_000,
        restartBackoffBaseMs: 100,
        restartBackoffMaxMs: 200,
        walRestartThresholdBytes: 4_096,
        walMaintenanceCheckIntervalMs: 100,
        walRestartIdleMs: 1_000,
        walRestartCooldownMs: 60_000,
        log: () => {},
      });
      const endpoint = `http://127.0.0.1:${port}`;
      const store = createManagedOxigraphSparqlStoreV1({
        queryEndpoint: `${endpoint}/query`,
        updateEndpoint: `${endpoint}/update`,
        timeout: 10_000,
      }, {
        getRecoveryState: () => handle.getRecoveryState(),
        registerActivity: () => handle.registerStoreActivity(),
        onClientTimeout: (operation) => handle.requestRestart(`${operation} timed out`),
        requestRecovery: (generation, operation) => handle.requestRecovery!(generation, `${operation} timed out`),
      });

      try {
        await store.insert(Array.from({ length: 500 }, (_, index) => ({
          subject: `urn:wal-maintenance:${index}`,
          predicate: 'urn:retained',
          object: `"value-${index}-${'x'.repeat(64)}"`,
          graph: 'urn:wal-maintenance-graph',
        })));
        const retainedBefore = measureRetainedWalBytes(location);
        expect(retainedBefore).toBeGreaterThanOrEqual(4_096);

        const deadline = Date.now() + 15_000;
        while (
          (handle.getRecoveryState().generation === 0 || handle.getRecoveryState().recovering)
          && Date.now() < deadline
        ) {
          await sleep(50);
        }
        expect(handle.getRecoveryState())
        .toEqual({ recovering: false, admissionsPaused: false, generation: 1 });
        expect(measureRetainedWalBytes(location)).toBeLessThan(retainedBefore);
        await expect(store.query(
          'ASK { GRAPH <urn:wal-maintenance-graph> { <urn:wal-maintenance:42> <urn:retained> ?o } }',
        )).resolves.toMatchObject({ type: 'boolean', value: true });
      } finally {
        await store.close();
        await handle.stop();
        await rm(location, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
